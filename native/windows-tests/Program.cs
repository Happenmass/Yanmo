using System;
using System.Collections.Generic;
using System.Linq;

class Tests {
    static int checks;
    static void Sequence(string name, int[] events, params int[] expected) {
        var tracker = new ShortcutTracker(); var result = new List<int>();
        foreach (int key in events) {
            if (key == 0) { tracker.Cancel(); continue; }
            int chord = tracker.Step(Math.Abs(key), key < 0);
            if (chord != 0) result.Add(chord);
        }
        if (!result.SequenceEqual(expected)) throw new Exception(name + ": " + string.Join(",", result));
        checks++;
    }
    static void Main() {
        Sequence("Left Ctrl releases once", new[] {0xA2, -0xA2}, 4096);
        Sequence("Right Ctrl releases once", new[] {0xA3, -0xA3}, 4096);
        Sequence("No action on key down", new[] {0xA2});
        Sequence("Repeat is ignored", new[] {0xA2, 0xA2, -0xA2}, 4096);
        Sequence("Ctrl Shift is one chord", new[] {0xA2, 0xA0, -0xA0, -0xA2}, 4608);
        Sequence("Reverse order, right keys", new[] {0xA1, 0xA3, -0xA3, -0xA1}, 4608);
        Sequence("Ctrl Space excludes dictation", new[] {0xA2, 0x20, -0x20, -0xA2});
        Sequence("Copy excludes dictation", new[] {0xA2, 0x43, -0x43, -0xA2});
        Sequence("Paste excludes dictation", new[] {0xA2, 0x56, -0xA2, -0x56});
        Sequence("Ctrl Shift selection excludes translation", new[] {0xA2, 0xA0, 0x25, -0x25, -0xA0, -0xA2});
        Sequence("Ctrl click excludes dictation", new[] {0xA2, 0, -0xA2});
        Sequence("Shift click excludes translation", new[] {0xA2, 0xA0, 0, -0xA0, -0xA2});
        Sequence("Typing before Ctrl excludes dictation", new[] {0x41, 0xA2, -0x41, -0xA2});
        Sequence("Both Ctrl keys trigger once", new[] {0xA2, 0xA3, -0xA2, -0xA3}, 4096);
        Sequence("Next press works after copy", new[] {0xA2, 0x43, -0x43, -0xA2, 0xA2, -0xA2}, 4096);
        Sequence("Start then stop", new[] {0xA2, -0xA2, 0xA2, -0xA2}, 4096, 4096);
        Console.WriteLine($"{checks} Windows shortcut sequences passed.");
    }
}
