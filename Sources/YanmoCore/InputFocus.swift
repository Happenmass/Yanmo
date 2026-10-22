/// Best-effort focus lookup for context and explicit selection, independent of
/// text delivery. OS reads are supplied for checks without a live editor.
public enum InputFocus {
    public static func resolve<Element>(system: () -> Element?, application: () -> Element?,
                                       prepareApplication: () -> Void,
                                       belongsToApplication: (Element) -> Bool) -> Element? {
        if let element = system(), belongsToApplication(element) { return element }
        prepareApplication()
        if let element = application(), belongsToApplication(element) { return element }
        return nil
    }
}
