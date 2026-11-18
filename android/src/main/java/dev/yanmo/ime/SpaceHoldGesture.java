package dev.yanmo.ime;

import android.graphics.RectF;
import android.os.SystemClock;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;

/** Keeps the original key view and intercepts only a long press on its actual space-key bounds. */
final class SpaceHoldGesture {
    private static final long HOLD_MS = 360;
    private final VoiceSession voice;
    private final Runnable begin = this::beginHold;
    private final float tolerance;
    private final View keyboard;
    private final Window window;
    private final Window.Callback delegate;
    private final Window.Callback callback;
    private MotionEvent down;
    private boolean holding;
    private float startY;
    private boolean loggedLookupFailure;

    SpaceHoldGesture(View keyboard, Window window, VoiceSession voice) {
        this.keyboard = keyboard;
        this.window = window;
        this.voice = voice;
        tolerance = 24 * keyboard.getResources().getDisplayMetrics().density;
        delegate = window.getCallback();
        callback = (Window.Callback) Proxy.newProxyInstance(
                Window.Callback.class.getClassLoader(), new Class<?>[] { Window.Callback.class },
                (proxy, method, args) -> {
                    if (method.getName().equals("dispatchTouchEvent")) {
                        return dispatchTouchEvent((MotionEvent) args[0]);
                    }
                    try {
                        return method.invoke(delegate, args);
                    } catch (InvocationTargetException cause) {
                        throw cause.getCause();
                    }
                });
        window.setCallback(callback);
    }

    private boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            cancelActiveGesture();
            if (findSpace(event)) {
                down = MotionEvent.obtain(event);
                startY = event.getY();
                keyboard.postDelayed(begin, HOLD_MS);
            }
        } else if (holding) {
            if (action == MotionEvent.ACTION_UP) {
                if (event.getY() < startY - 2 * tolerance) voice.cancel();
                else voice.stop();
                holding = false;
            } else if (action == MotionEvent.ACTION_CANCEL || action == MotionEvent.ACTION_POINTER_DOWN) {
                cancelActiveGesture();
            }
            return true;
        } else if (down != null && (action == MotionEvent.ACTION_UP
                || action == MotionEvent.ACTION_CANCEL || action == MotionEvent.ACTION_POINTER_DOWN
                || action == MotionEvent.ACTION_MOVE && (Math.abs(event.getX() - down.getX()) > tolerance
                || Math.abs(event.getY() - down.getY()) > tolerance))) {
            clearPending();
        }
        return delegate.dispatchTouchEvent(event);
    }

    void cancelActiveGesture() {
        clearPending();
        if (holding) voice.cancel();
        holding = false;
    }

    void detach() {
        cancelActiveGesture();
        if (window.getCallback() == callback) window.setCallback(delegate);
    }

    private void clearPending() {
        keyboard.removeCallbacks(begin);
        if (down == null) return;
        down.recycle();
        down = null;
    }

    private void beginHold() {
        if (down == null || !keyboard.isShown() || !findSpace(down)) {
            clearPending();
            return;
        }
        MotionEvent cancel = MotionEvent.obtain(down.getDownTime(), SystemClock.uptimeMillis(),
                MotionEvent.ACTION_CANCEL, down.getX(), down.getY(), 0);
        delegate.dispatchTouchEvent(cancel);
        cancel.recycle();
        clearPending();
        holding = true;
        keyboard.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
        voice.start();
    }

    private boolean findSpace(MotionEvent event) {
        View compose = composeChild(keyboard);
        if (compose == null) return false;
        float x = event.getX();
        float y = event.getY();
        try {
            return new SpaceSemantics(compose).contains(x, y);
        } catch (ReflectiveOperationException | RuntimeException failure) {
            if (!loggedLookupFailure) {
                Log.w("YanmoIme", "Could not locate the pinned upstream space key", failure);
                loggedLookupFailure = true;
            }
            return false;
        }
    }

    private static View composeChild(View view) {
        if (view.getClass().getName().equals("androidx.compose.ui.platform.AndroidComposeView")) return view;
        if (view instanceof ViewGroup group) {
            for (int index = 0; index < group.getChildCount(); index++) {
                View compose = composeChild(group.getChildAt(index));
                if (compose != null) return compose;
            }
        }
        return null;
    }

    private static final class SpaceSemantics {
        private final Object root;
        private final Method children;
        private final Method config;
        private final Method boundsInWindow;
        private final Field properties;
        private final Method property;
        private final Object testTag;
        private final Field left;
        private final Field top;
        private final Field right;
        private final Field bottom;

        SpaceSemantics(View compose) throws ReflectiveOperationException {
            Object owner = compose.getClass().getMethod("getSemanticsOwner").invoke(compose);
            root = owner.getClass().getMethod("getUnmergedRootSemanticsNode").invoke(owner);
            Class<?> nodeClass = root.getClass();
            children = nodeClass.getMethod("getChildren$ui", boolean.class, boolean.class);
            config = nodeClass.getMethod("getConfig");
            boundsInWindow = nodeClass.getMethod("getBoundsInWindow");
            properties = config.getReturnType().getField("props");
            property = properties.getType().getMethod("get", Object.class);
            testTag = Class.forName("androidx.compose.ui.semantics.SemanticsProperties",
                    true, compose.getClass().getClassLoader()).getField("TestTag").get(null);
            Class<?> rectClass = boundsInWindow.getReturnType();
            left = rectClass.getField("left");
            top = rectClass.getField("top");
            right = rectClass.getField("right");
            bottom = rectClass.getField("bottom");
        }

        boolean contains(float x, float y) throws ReflectiveOperationException {
            return contains(root, x, y);
        }

        private boolean contains(Object node, float x, float y) throws ReflectiveOperationException {
            Object values = properties.get(config.invoke(node));
            if ("space-key".equals(property.invoke(values, testTag))) {
                Object bounds = boundsInWindow.invoke(node);
                if (new RectF(left.getFloat(bounds), top.getFloat(bounds),
                        right.getFloat(bounds), bottom.getFloat(bounds)).contains(x, y)) return true;
            }
            for (Object child : (List<?>) children.invoke(node, false, false)) {
                if (contains(child, x, y)) return true;
            }
            return false;
        }
    }
}
