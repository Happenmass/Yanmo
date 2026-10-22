import AppKit

// Render the approved ink artwork at every native icon size, with transparent macOS corners.
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
let source = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "docs/design/logo-v2.png"
guard let artwork = NSImage(contentsOfFile: source) else {
    fatalError("Cannot load approved Yanmo icon artwork: \(source)")
}
for (name, pixels) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    let size = CGFloat(pixels)
    // An explicit bitmap avoids lockFocus doubling every output on Retina displays.
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.cgContext.clear(CGRect(x: 0, y: 0, width: size, height: size))
    let inset = size * 0.055
    let bounds = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    NSGraphicsContext.current?.imageInterpolation = .high
    NSBezierPath(roundedRect: bounds, xRadius: size * 0.19, yRadius: size * 0.19).addClip()
    artwork.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(name + ".png"))
}
