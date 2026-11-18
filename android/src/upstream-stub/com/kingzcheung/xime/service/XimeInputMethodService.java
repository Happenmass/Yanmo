package com.kingzcheung.xime.service;

import android.inputmethodservice.InputMethodService;
import android.view.View;

/** Compile-time view of the public superclass. This class is never included in the overlay DEX. */
public class XimeInputMethodService extends InputMethodService {
    @Override public View onCreateInputView() {
        throw new AssertionError("compile-time stub");
    }
}
