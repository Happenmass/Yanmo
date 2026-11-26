package dev.yanmo.ime;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * LAN mDNS discovery for {@code _acpm._tcp.} using Android {@link NsdManager}.
 * Holds {@link WifiManager.MulticastLock} only for the bounded discovery window.
 */
final class NsdHubDiscovery {
    private static final String SERVICE_TYPE = "_acpm._tcp.";
    private static final long DEFAULT_TIMEOUT_MS = 2_500L;

    private NsdHubDiscovery() {}

    static List<SyncModels.DiscoveredHub> discover(Context context) {
        return discover(context, DEFAULT_TIMEOUT_MS);
    }

    static List<SyncModels.DiscoveredHub> discover(Context context, long timeoutMs) {
        Context app = context.getApplicationContext();
        NsdManager nsd = (NsdManager) app.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) return Collections.emptyList();

        WifiManager wifi = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = null;
        try {
            if (wifi != null) {
                lock = wifi.createMulticastLock("yanmo-mdns");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
        } catch (RuntimeException ignored) {
            lock = null;
        }

        Map<String, SyncModels.DiscoveredHub> found = Collections.synchronizedMap(new LinkedHashMap<>());
        List<Runnable> cleanups = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch stopLatch = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        AtomicBoolean stopped = new AtomicBoolean(false);
        ConcurrentLinkedQueue<NsdServiceInfo> legacyQueue = new ConcurrentLinkedQueue<>();
        AtomicBoolean legacyResolving = new AtomicBoolean(false);

        NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                stopLatch.countDown();
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                stopLatch.countDown();
            }

            @Override
            public void onDiscoveryStarted(String serviceType) {}

            @Override
            public void onDiscoveryStopped(String serviceType) {
                stopLatch.countDown();
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (stopped.get()) return;
                if (Build.VERSION.SDK_INT >= 34) {
                    resolveApi34(nsd, serviceInfo, executor, cleanups, found, stopped);
                } else {
                    legacyQueue.add(serviceInfo);
                    drainLegacyQueue(nsd, legacyQueue, legacyResolving, found, stopped);
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {}
        };

        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
            Thread.sleep(Math.max(300L, timeoutMs));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException ignored) {
        } finally {
            stopped.set(true);
            for (Runnable cleanup : new ArrayList<>(cleanups)) {
                try { cleanup.run(); } catch (RuntimeException ignored) {}
            }
            try {
                nsd.stopServiceDiscovery(discoveryListener);
                stopLatch.await(400L, TimeUnit.MILLISECONDS);
            } catch (Exception ignored) {
            }
            executor.shutdownNow();
            if (lock != null && lock.isHeld()) {
                try { lock.release(); } catch (RuntimeException ignored) {}
            }
        }
        return new ArrayList<>(found.values());
    }

    @SuppressWarnings("NewApi")
    private static void resolveApi34(
            NsdManager nsd,
            NsdServiceInfo info,
            ExecutorService executor,
            List<Runnable> cleanups,
            Map<String, SyncModels.DiscoveredHub> found,
            AtomicBoolean stopped
    ) {
        NsdManager.ServiceInfoCallback cb = new NsdManager.ServiceInfoCallback() {
            @Override
            public void onServiceInfoCallbackRegistrationFailed(int errorCode) {}

            @Override
            public void onServiceUpdated(NsdServiceInfo updated) {
                if (stopped.get()) return;
                SyncModels.DiscoveredHub hub = parseResolved(updated);
                if (hub != null) mergeDiscovered(found, hub);
            }

            @Override
            public void onServiceLost() {}

            @Override
            public void onServiceInfoCallbackUnregistered() {}
        };
        try {
            nsd.registerServiceInfoCallback(info, executor, cb);
            cleanups.add(() -> nsd.unregisterServiceInfoCallback(cb));
        } catch (RuntimeException ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private static void drainLegacyQueue(
            NsdManager nsd,
            ConcurrentLinkedQueue<NsdServiceInfo> queue,
            AtomicBoolean resolving,
            Map<String, SyncModels.DiscoveredHub> found,
            AtomicBoolean stopped
    ) {
        if (stopped.get() || !resolving.compareAndSet(false, true)) return;
        NsdServiceInfo next = queue.poll();
        if (next == null) {
            resolving.set(false);
            return;
        }
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    resolving.set(false);
                    drainLegacyQueue(nsd, queue, resolving, found, stopped);
                }

                @Override
                public void onServiceResolved(NsdServiceInfo serviceInfo) {
                    if (!stopped.get()) {
                        SyncModels.DiscoveredHub hub = parseResolved(serviceInfo);
                        if (hub != null) mergeDiscovered(found, hub);
                    }
                    resolving.set(false);
                    drainLegacyQueue(nsd, queue, resolving, found, stopped);
                }
            });
        } catch (RuntimeException failure) {
            resolving.set(false);
        }
    }

    private static SyncModels.DiscoveredHub parseResolved(NsdServiceInfo info) {
        Map<String, byte[]> attrs = info.getAttributes();
        if (attrs == null) return null;
        String version = attrString(attrs.get("v"));
        String hubId = attrString(attrs.get("id"));
        String fp = attrString(attrs.get("fp")).toLowerCase(Locale.ROOT);
        if (!"1".equals(version) || hubId.isEmpty() || !fp.matches("^[0-9a-f]{16}$")) {
            return null;
        }
        boolean syncEnabled = "1".equals(attrString(attrs.get("sync")));
        String apiRaw = attrString(attrs.get("api"));
        String apiPrefix = apiRaw.isEmpty() ? "/v1" : (apiRaw.startsWith("/") ? apiRaw : "/" + apiRaw);
        int port = info.getPort();
        if (port <= 0) return null;

        List<String> addrs = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 34) {
            for (InetAddress addr : info.getHostAddresses()) {
                if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                    String hostAddr = addr.getHostAddress();
                    if (hostAddr != null && !addrs.contains(hostAddr)) addrs.add(hostAddr);
                }
            }
            for (InetAddress addr : info.getHostAddresses()) {
                if (!addr.isLoopbackAddress() && !addr.isLinkLocalAddress()) {
                    String hostAddr = addr.getHostAddress();
                    if (hostAddr != null && !addrs.contains(hostAddr)) addrs.add(hostAddr);
                }
            }
        } else {
            @SuppressWarnings("deprecation")
            InetAddress host = info.getHost();
            if (host != null && host.getHostAddress() != null) {
                addrs.add(host.getHostAddress());
            }
        }
        String hostName = info.getServiceName() == null ? "" : info.getServiceName();
        if (addrs.isEmpty()) return null;
        return new SyncModels.DiscoveredHub(hostName, hostName, addrs, port, hubId, fp, syncEnabled, apiPrefix);
    }

    private static void mergeDiscovered(Map<String, SyncModels.DiscoveredHub> found, SyncModels.DiscoveredHub hub) {
        SyncModels.DiscoveredHub prev = found.get(hub.hubInstanceId);
        if (prev == null) {
            found.put(hub.hubInstanceId, hub);
            return;
        }
        List<String> mergedAddrs = new ArrayList<>(prev.addresses);
        for (String a : hub.addresses) {
            if (!mergedAddrs.contains(a)) mergedAddrs.add(a);
        }
        found.put(hub.hubInstanceId, new SyncModels.DiscoveredHub(
                hub.serviceName, hub.host, mergedAddrs, hub.port, hub.hubInstanceId,
                hub.serverPubkeyFp, hub.syncEnabled, hub.apiPrefix
        ));
    }

    private static String attrString(byte[] raw) {
        return raw == null ? "" : new String(raw, StandardCharsets.UTF_8).trim();
    }
}
