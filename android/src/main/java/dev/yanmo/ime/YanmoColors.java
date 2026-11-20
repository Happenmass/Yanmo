package dev.yanmo.ime;

import android.content.res.ColorStateList;

final class YanmoColors {
    final int paper, ink, secondary, rule, accent, ready, warning, pressed;

    YanmoColors(boolean dark) {
        paper = dark ? 0xff25211e : 0xfff8f4eb;
        ink = dark ? 0xfff0e9dc : 0xff2b251f;
        secondary = dark ? 0xffc2b6a7 : 0xff63584a;
        rule = dark ? 0xff544a3e : 0xffd6cebf;
        accent = dark ? 0xffe68c7b : 0xff9c3125;
        ready = dark ? 0xff8bb4bb : 0xff2b5965;
        warning = dark ? 0xffe1b280 : 0xff7b4c1f;
        pressed = dark ? 0x26f0e9dc : 0x201c1711;
    }

    ColorStateList fieldTint() {
        return tint(android.R.attr.state_focused, accent, rule);
    }

    ColorStateList toggleTint() {
        return tint(android.R.attr.state_checked, accent, secondary);
    }

    private static ColorStateList tint(int state, int active, int inactive) {
        return new ColorStateList(new int[][] {{state}, {}}, new int[] {active, inactive});
    }
}
