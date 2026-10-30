using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

// Same JSON-lines protocol as the Mac bridge. No model code or network access.
static class Program {
    static readonly object OutputLock = new();
    static readonly Dictionary<string, string> Selections = new();
    static readonly HashSet<string> AudioFiles = new();
    static readonly Dictionary<int, int> Keys = new() {
        [0]=0x41,[1]=0x53,[2]=0x44,[3]=0x46,[4]=0x48,[5]=0x47,[6]=0x5A,[7]=0x58,[8]=0x43,[9]=0x56,
        [11]=0x42,[12]=0x51,[13]=0x57,[14]=0x45,[15]=0x52,[16]=0x59,[17]=0x54,[18]=0x31,[19]=0x32,[20]=0x33,
        [21]=0x34,[22]=0x36,[23]=0x35,[24]=0xBB,[25]=0x39,[26]=0x37,[27]=0xBD,[28]=0x38,[29]=0x30,
        [30]=0xDD,[31]=0x4F,[32]=0x55,[33]=0xDB,[34]=0x49,[35]=0x50,[37]=0x4C,[38]=0x4A,[39]=0xDE,
        [40]=0x4B,[41]=0xBA,[42]=0xDC,[43]=0xBC,[44]=0xBF,[45]=0x4E,[46]=0x4D,[47]=0xBE,[49]=0x20,[50]=0xC0,
        [122]=0x70,[120]=0x71,[99]=0x72,[118]=0x73,[96]=0x74,[97]=0x75,[98]=0x76,[100]=0x77,[101]=0x78,[109]=0x79,[103]=0x7A,[111]=0x7B
    };
    record Binding(string Action, int Key, int Modifiers);
    static List<Binding> bindings = new();
    static readonly HashSet<int> Swallowed = new();
    static bool capturing, active, readContext;
    static long activeGeneration;
    static Form dispatcher = null!;
    static IntPtr hook, mouseHook;
    static readonly ShortcutTracker Tracker = new();
    static readonly HookProc MouseDelegate = Mouse;
    static readonly HookProc HookDelegate = Keyboard;
    static Recorder? recorder;
    static readonly int ParentPID = int.TryParse(Environment.GetEnvironmentVariable("YANMO_PARENT_PID"), out var pid) ? pid : -1;
    static void Send(object value) { lock(OutputLock) Console.WriteLine(JsonSerializer.Serialize(value)); }
    static bool Down(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;
    static int Modifiers() => (Down(0x11)?4096:0) | (Down(0x12)?2048:0) | (Down(0x10)?512:0);
    static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
        if(code < 0) return CallNextHookEx(hook, code, message, data);
        var key = Marshal.PtrToStructure<KeyboardData>(data);
        if((key.flags & 0x10) != 0) return CallNextHookEx(hook, code, message, data);
        var vk = (int)key.vkCode; var msg = message.ToInt32();
        bool up = msg == 0x101 || msg == 0x105;
        int chord = Tracker.Step(vk, up);
        if (chord != 0) {
            if (capturing && (chord & 4096) != 0 && (chord & ~6656) == 0) {
                int[] codes = new[] { 59, 58, 56 }.Where(x => (chord & (x == 59 ? 4096 : x == 58 ? 2048 : 512)) != 0).ToArray();
                dispatcher.BeginInvoke((Action)(() => Send(new { @event="shortcutCaptured", shortcut=new { keyCode=0, modifiers=0, keyLabel="Control", modifierKeys=codes } })));
            } else if (!capturing) {
                var released = bindings.FirstOrDefault(x => x.Key == 0 && x.Modifiers == chord);
                if (released != null) Fire(released);
            }
        }
        if(up && Swallowed.Remove(vk)) return (IntPtr)1;
        if(!up && Swallowed.Contains(vk)) return (IntPtr)1;
        if(!up && (msg == 0x100 || msg == 0x104)) {
            if(vk == 0x1B && (active || capturing)) {
                Swallowed.Add(vk);
                dispatcher.BeginInvoke((Action)(() => { if(capturing) Send(new { @event="shortcutCaptured" }); else Send(new { @event="cancel" }); }));
                return (IntPtr)1;
            }
            int mods = Tracker.Modifiers;
            if(capturing && (mods & 4096) != 0 && Keys.ContainsValue(vk)) {
                int carbon = Keys.First(x => x.Value == vk).Key;
                Swallowed.Add(vk);
                dispatcher.BeginInvoke((Action)(() => Send(new { @event="shortcutCaptured", shortcut=new { keyCode=carbon, modifiers=mods, keyLabel=vk==0x20?"Space":((System.Windows.Forms.Keys)vk).ToString() } })));
                return (IntPtr)1;
            }
            var binding = capturing ? null : bindings.FirstOrDefault(x => x.Key == vk && x.Modifiers == mods);
            if(binding != null) {
                Swallowed.Add(vk);
                // Return from the low-level hook before potentially slow UI Automation calls.
                Fire(binding);
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }
    static void Fire(Binding binding) => dispatcher.BeginInvoke((Action)(() => Send(new { @event="shortcut", action=binding.Action, destination=Capture(readContext) })));
    static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
        // Ctrl+click and Ctrl+wheel remain ordinary application gestures.
        if (code >= 0 && message.ToInt32() is 0x201 or 0x204 or 0x207 or 0x20B or 0x20A or 0x20E) Tracker.Cancel();
        return CallNextHookEx(mouseHook, code, message, data);
    }
    static Dictionary<string,object> Capture(bool context) {
        GetWindowThreadProcessId(GetForegroundWindow(), out uint pid);
        string name="当前应用";
        try { name=Process.GetProcessById((int)pid).ProcessName; } catch { }
        var result = new Dictionary<string,object> { ["name"]=name, ["category"]="general" };
        if(pid == ParentPID) return result;
        try {
            var element=AutomationElement.FocusedElement;
            if(element == null) return result;
            if(element.Current.IsPassword) { result["secure"]=true; return result; }
            if(element.TryGetCurrentPattern(TextPattern.Pattern, out var raw)) {
                var pattern=(TextPattern)raw;
                var selected=pattern.GetSelection().FirstOrDefault();
                if(selected != null) {
                    string text=selected.GetText(20001); string id=Guid.NewGuid().ToString();
                    // Keep only the latest destination; active(false) also clears it.
                    Selections.Clear(); Selections[id]=text; result["id"]=id;
                    if(context) {
                        var before=selected.Clone(); before.MoveEndpointByRange(TextPatternRangeEndpoint.End, selected, TextPatternRangeEndpoint.Start); before.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -300);
                        var after=selected.Clone(); after.MoveEndpointByRange(TextPatternRangeEndpoint.Start, selected, TextPatternRangeEndpoint.End); after.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, 300);
                        result["before"]=before.GetText(300); result["after"]=after.GetText(300);
                    }
                }
            }
        } catch { /* Unsupported controls provide no context or selected text. */ }
        return result;
    }
    static object Status() => new { accessibility=true, eventTap=hook!=IntPtr.Zero, microphone=0, devices=Recorder.Devices() };
    static async Task<object> Handle(string command, JsonElement args) {
        string S(string name) => args.TryGetProperty(name,out var x) ? x.GetString()??"" : "";
        bool B(string name) => args.TryGetProperty(name,out var x) && x.ValueKind==JsonValueKind.True;
        switch(command) {
            case "status": case "permissions": return Status();
            case "configure":
                var next=new List<Binding>();
                foreach(var item in args.GetProperty("bindings").EnumerateArray()) {
                    var key=item.GetProperty("shortcut"); int carbon=key.GetProperty("keyCode").GetInt32(), mods=key.GetProperty("modifiers").GetInt32();
                    int vk;
                    if (key.TryGetProperty("modifierKeys", out var modifierKeys)) {
                        mods = 0;
                        foreach (var value in modifierKeys.EnumerateArray()) mods |= value.GetInt32() switch { 59 or 62 => 4096, 56 or 60 => 512, 58 or 61 => 2048, _ => throw new Exception("Windows 不支持该修饰键。") };
                        vk = 0;
                    } else if (!Keys.TryGetValue(carbon, out vk)) throw new Exception("Windows 不支持该按键。");
                    if ((mods & ~6656)!=0 || (mods & 4096)==0 || next.Any(x => x.Key == vk && x.Modifiers == mods)) throw new Exception("Windows 快捷键需要 Control，且不能重复。");
                    next.Add(new Binding(item.GetProperty("action").GetString()!,vk,mods));
                }
                bindings=next; capturing=false; Tracker.Reset(); readContext=B("readContext"); return Status();
            case "captureShortcut": capturing=B("enabled"); Tracker.Cancel(); return Status();
            case "active": active=B("value"); if(!active) { Selections.Clear(); activeGeneration++; } return new {};
            case "capture": return Capture(B("readContext"));
            case "release": Selections.Remove(S("destinationId")); return new {};
            case "selection":
                if(!Selections.Remove(S("destinationId"),out string? selected) || string.IsNullOrEmpty(selected)) throw new Exception("请先选中文字，再按划词翻译快捷键；当前控件需支持 Windows UI Automation。");
                return new { text=selected };
            case "insert":
                long generation=activeGeneration;
                string text=S("text"); if(text.Length==0) throw new Exception("没有可写入的正文。");
                // Let the triggering shortcut's modifiers go before sending Ctrl+V.
                for(int i=0;i<100 && Modifiers()!=0;i++) await Task.Delay(30);
                if(!active || generation!=activeGeneration) throw new OperationCanceledException("写入已取消，正文已保留。");
                if(Modifiers()!=0) throw new Exception("请松开快捷键后重试，正文已保留在文稿中。");
                var target=Capture(false); if(target.ContainsKey("secure")) throw new Exception("密码输入框不写入正文。");
                var previous=System.Windows.Forms.Clipboard.GetDataObject();
                System.Windows.Forms.Clipboard.SetText(text);
                uint sequence=GetClipboardSequenceNumber();
                _=RestoreClipboard(previous,sequence);
                var inputs=new[] { KeyInput(0x11,false),KeyInput(0x56,false),KeyInput(0x56,true),KeyInput(0x11,true) };
                if(SendInput(4,inputs,Marshal.SizeOf<Input>())!=4) throw new Exception("无法粘贴到当前程序；请确认目标程序未以管理员权限运行。正文已保留。");
                return new { delivery="attempted_unverified", name=target["name"], message="已向当前输入位置发送一次粘贴。" };
            case "record.start":
                recorder?.Dispose(); recorder=new Recorder(S("device"),S("taskId"),Send); return new {};
            case "record.finish":
                if(recorder==null) throw new Exception("录音没有生成。");
                var path=recorder.Finish(); recorder.Dispose(); recorder=null; AudioFiles.Add(path); return new { path };
            case "record.cancel": recorder?.Dispose(); recorder=null; return new {};
            case "audio.import":
                string source=S("path"); string temp=Path.Combine(Path.GetTempPath(),"yanmo-"+Guid.NewGuid()+Path.GetExtension(source));
                File.Copy(source,temp); AudioFiles.Add(temp); return new { path=temp, seconds=0 };
            case "audio.delete": string file=S("path"); if(AudioFiles.Remove(file)) File.Delete(file); return new {};
            default: throw new Exception("未知的系统桥接操作。");
        }
    }
    static async Task RestoreClipboard(System.Windows.Forms.IDataObject? previous, uint sequence) {
        await Task.Delay(900);
        if(GetClipboardSequenceNumber()==sequence) try { if(previous!=null) System.Windows.Forms.Clipboard.SetDataObject(previous,true); else System.Windows.Forms.Clipboard.Clear(); } catch { }
    }
    static Input KeyInput(ushort vk,bool up) => new() { type=1, data=new InputUnion { keyboard=new KeyboardInput { vk=vk, flags=up?2u:0u } } };
    [STAThread] static void Main() {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        dispatcher=new Form(); _=dispatcher.Handle;
        hook=SetWindowsHookEx(13,HookDelegate,GetModuleHandle(null),0);
        if(hook==IntPtr.Zero) { Send(new { @event="fault", message="Windows 键盘钩子启动失败。" }); return; }
        mouseHook=SetWindowsHookEx(14,MouseDelegate,GetModuleHandle(null),0);
        Send(new { @event="ready", protocol=1 });
        _=Task.Run(async () => {
            string? line;
            while((line=await Console.In.ReadLineAsync())!=null) {
                string request=line;
                dispatcher.BeginInvoke((Action)(async () => {
                    string id="";
                    try { using var doc=JsonDocument.Parse(request); var root=doc.RootElement; id=root.GetProperty("id").GetString()!; var value=await Handle(root.GetProperty("command").GetString()!,root.GetProperty("args")); Send(new { id, ok=true, result=value }); }
                    catch(Exception error) { Send(new { id, ok=false, error=error.Message }); }
                }));
            }
            dispatcher.BeginInvoke((Action)(() => Application.ExitThread()));
        });
        try { Application.Run(); } finally { recorder?.Dispose(); UnhookWindowsHookEx(hook); if(mouseHook!=IntPtr.Zero) UnhookWindowsHookEx(mouseHook); foreach(var path in AudioFiles) try { File.Delete(path); } catch { } }
    }
    delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct KeyboardData { public uint vkCode,scanCode,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KeyboardInput keyboard; [FieldOffset(0)] public MouseInput mouse; }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x,y; public uint mouseData,flags,time; public UIntPtr extra; }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int type,HookProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] input,int size);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
}

sealed class Recorder : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Format { public ushort tag,channels; public uint rate,bytes; public ushort align,bits,extra; }
    [StructLayout(LayoutKind.Sequential)] struct Header { public IntPtr data; public uint length,recorded; public UIntPtr user; public uint flags,loops; public IntPtr next; public UIntPtr reserved; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Caps { public ushort mid,pid; public uint version; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name; public uint formats; public ushort channels,reserved; public uint support; }
    delegate void Callback(IntPtr handle,uint message,UIntPtr instance,IntPtr header,UIntPtr reserved);
    readonly Callback callback;
    readonly List<IntPtr> buffers=new();
    readonly object sync=new();
    readonly Action<object> send;
    readonly string taskId;
    readonly FileStream file;
    readonly string path;
    IntPtr device;
    volatile bool running;
    bool finished;
    long lastMeter;
    public static object[] Devices() {
        var devices=new List<object>();
        for(uint i=0;i<waveInGetNumDevs();i++) if(waveInGetDevCaps((UIntPtr)i,out var caps,(uint)Marshal.SizeOf<Caps>())==0) devices.Add(new { id=i.ToString(), name=caps.name });
        return devices.ToArray();
    }
    public Recorder(string chosen,string id,Action<object> emit) {
        callback=Data; taskId=id; send=emit;
        path=Path.Combine(Path.GetTempPath(),"yanmo-"+Guid.NewGuid()+".wav"); file=new FileStream(path,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read); file.Write(new byte[44]);
        try {
            var format=new Format { tag=1,channels=1,rate=16000,bytes=32000,align=2,bits=16 };
            uint index=uint.TryParse(chosen,out var value)?value:uint.MaxValue;
            Check(waveInOpen(out device,index,ref format,callback,UIntPtr.Zero,0x30000));
            for(int i=0;i<4;i++) {
                var header=new Header { data=Marshal.AllocHGlobal(4096),length=4096 };
                var pointer=Marshal.AllocHGlobal(Marshal.SizeOf<Header>()); Marshal.StructureToPtr(header,pointer,false); buffers.Add(pointer);
                Check(waveInPrepareHeader(device,pointer,(uint)Marshal.SizeOf<Header>())); Check(waveInAddBuffer(device,pointer,(uint)Marshal.SizeOf<Header>()));
            }
            running=true; Check(waveInStart(device));
        } catch { Dispose(); throw; }
    }
    static void Check(uint code) { if(code!=0) throw new Exception("无法打开麦克风，请检查 Windows 麦克风隐私设置和输入设备（"+code+"）。"); }
    void Data(IntPtr handle,uint message,UIntPtr instance,IntPtr pointer,UIntPtr reserved) {
        if(message!=0x3C0) return;
        lock(sync) {
            if(!buffers.Contains(pointer)) return;
            var header=Marshal.PtrToStructure<Header>(pointer);
            if(header.recorded>0) {
                var bytes=new byte[header.recorded]; Marshal.Copy(header.data,bytes,0,bytes.Length); file.Write(bytes);
                if(Environment.TickCount64-lastMeter>70) {
                    double peak=0; for(int i=0;i+1<bytes.Length;i+=2) peak=Math.Max(peak,Math.Abs((double)BitConverter.ToInt16(bytes,i))/32768);
                    lastMeter=Environment.TickCount64; send(new { @event="meter", taskId, level=peak });
                }
            }
            if(running) waveInAddBuffer(device,pointer,(uint)Marshal.SizeOf<Header>());
        }
    }
    void Stop() {
        running=false;
        if(device==IntPtr.Zero) return;
        waveInStop(device); waveInReset(device);
        lock(sync) {
            foreach(var pointer in buffers) {
                waveInUnprepareHeader(device,pointer,(uint)Marshal.SizeOf<Header>());
                Marshal.FreeHGlobal(Marshal.PtrToStructure<Header>(pointer).data); Marshal.FreeHGlobal(pointer);
            }
            buffers.Clear();
        }
        waveInClose(device); device=IntPtr.Zero;
    }
    public string Finish() {
        Stop(); lock(sync) {
            long length=file.Length-44; if(length<=0) throw new Exception("录音为空，请检查麦克风。");
            file.Position=0; using var writer=new BinaryWriter(file,Encoding.UTF8,true);
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write((uint)(length+36)); writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16); writer.Write((ushort)1); writer.Write((ushort)1); writer.Write(16000); writer.Write(32000); writer.Write((ushort)2); writer.Write((ushort)16); writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write((uint)length); writer.Flush();
            file.Dispose(); finished=true; return path;
        }
    }
    public void Dispose() { Stop(); file.Dispose(); if(!finished) try { File.Delete(path); } catch { } }
    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll",CharSet=CharSet.Unicode)] static extern uint waveInGetDevCaps(UIntPtr index,out Caps caps,uint size);
    [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr handle,uint index,ref Format format,Callback callback,UIntPtr instance,uint flags);
    [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr device,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr device,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr device,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr device);
    [DllImport("winmm.dll")] static extern uint waveInStop(IntPtr device);
    [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr device);
    [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr device);
}
