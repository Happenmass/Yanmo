import AppKit

// Draw an original vector-like seal into the macOS icon set. No third-party assets.
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
for (name, pixels) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    let size = CGFloat(pixels)
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let inset = size * 0.055
    NSColor(calibratedRed: 0.65, green: 0.26, blue: 0.20, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset), xRadius: size * 0.19, yRadius: size * 0.19).fill()
    let style = NSMutableParagraphStyle(); style.alignment = .center
    let font = NSFont(name: "Songti SC Bold", size: size * 0.76) ?? NSFont.systemFont(ofSize: size * 0.76)
    ("言" as NSString).draw(in: NSRect(x: 0, y: size * 0.055, width: size, height: size * 0.9), withAttributes: [.font: font, .foregroundColor: NSColor(calibratedRed: 0.966, green: 0.954, blue: 0.925, alpha: 1), .paragraphStyle: style])
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(name + ".png"))
}
