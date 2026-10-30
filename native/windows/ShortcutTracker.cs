using System.Collections.Generic;
using System.Linq;

// Pure keyboard state shared by the Win32 hook and cross-platform sequence tests.
// Modifier-only shortcuts fire on release, after ruling out Ctrl+C, Ctrl+click, etc.
sealed class ShortcutTracker {
    readonly HashSet<int> pressed = new();
    int chord;
    bool blocked;
    public static int Modifier(int vk) => vk switch {
        0x11 or 0xA2 or 0xA3 => 4096,
        0x10 or 0xA0 or 0xA1 => 512,
        0x12 or 0xA4 or 0xA5 => 2048,
        0x5B or 0x5C => 256,
        _ => 0
    };
    public int Modifiers => pressed.Aggregate(0, (bits, vk) => bits | Modifier(vk));
    public void Cancel() { blocked = true; }
    public void Reset() { pressed.Clear(); chord = 0; blocked = false; }
    public int Step(int vk, bool up) {
        if (!up) {
            if (pressed.Contains(vk)) return 0;
            if (Modifier(vk) != 0 && Modifiers == 0) {
                chord = 0; blocked = pressed.Count != 0;
            }
            pressed.Add(vk);
            if (Modifier(vk) == 0) blocked = true;
            else chord |= Modifier(vk);
            return 0;
        }
        if (!pressed.Remove(vk) || Modifier(vk) == 0 || Modifiers != 0) return 0;
        int result = blocked ? 0 : chord;
        chord = 0; blocked = false;
        return result;
    }
}
