import AppKit

// A small brush with an ink-filled tip; no font rendering or scaled app artwork.
// Coordinates are in a 20 pt square, leaving clear space on every edge.
func drawBrush(_ color: NSColor = .black) {
    color.setFill()
    let handle = NSBezierPath()
    handle.move(to: NSPoint(x: 10.3, y: 11.2))
    handle.line(to: NSPoint(x: 14.5, y: 17.0))
    handle.curve(to: NSPoint(x: 17.2, y: 14.5), controlPoint1: NSPoint(x: 16.2, y: 19.0), controlPoint2: NSPoint(x: 19.0, y: 16.2))
    handle.line(to: NSPoint(x: 11.8, y: 10.0))
    handle.close()
    handle.fill()

    let ink = NSBezierPath()
    ink.move(to: NSPoint(x: 9.0, y: 10.0))
    ink.curve(to: NSPoint(x: 5.8, y: 9.3), controlPoint1: NSPoint(x: 7.8, y: 10.8), controlPoint2: NSPoint(x: 6.7, y: 10.3))
    ink.curve(to: NSPoint(x: 2.0, y: 2.4), controlPoint1: NSPoint(x: 4.2, y: 7.6), controlPoint2: NSPoint(x: 4.5, y: 4.0))
    ink.curve(to: NSPoint(x: 7.4, y: 3.8), controlPoint1: NSPoint(x: 4.3, y: 2.4), controlPoint2: NSPoint(x: 6.1, y: 2.7))
    ink.curve(to: NSPoint(x: 10.3, y: 7.7), controlPoint1: NSPoint(x: 10.0, y: 4.9), controlPoint2: NSPoint(x: 11.3, y: 6.3))
    ink.close()
    // One tapered gap suggests the brush's split hairs without fine texture.
    ink.move(to: NSPoint(x: 3.5, y: 3.5))
    ink.curve(to: NSPoint(x: 8.0, y: 8.0), controlPoint1: NSPoint(x: 5.8, y: 4.9), controlPoint2: NSPoint(x: 5.9, y: 7.3))
    ink.curve(to: NSPoint(x: 3.5, y: 3.5), controlPoint1: NSPoint(x: 6.8, y: 5.7), controlPoint2: NSPoint(x: 5.6, y: 4.0))
    ink.close()
    ink.windingRule = .evenOdd
    ink.fill()
}

let output = URL(fileURLWithPath: CommandLine.arguments[1])
for scale in [1, 2] {
    let pixels = 20 * scale
    // Explicit pixel dimensions avoid lockFocus inheriting the screen's scale.
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    context.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    drawBrush()
    NSGraphicsContext.restoreGraphicsState()
    let path = scale == 1 ? output : output.deletingLastPathComponent().appendingPathComponent(output.deletingPathExtension().lastPathComponent + "@2x.png")
    try bitmap.representation(using: .png, properties: [:])!.write(to: path)
}
