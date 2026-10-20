// sfgen <spec.json> <out.json>
// spec: [{"key":..., "name": sf symbol, "pt": point size, "weight": "regular|medium|semibold|light", "mode": "natural|square"}]
// out:  {key: {"uri": data:image/png;base64,..., "w": pt, "h": pt, "inkW", "inkH"}}   (rendered at 3x, black glyph on transparent = mask)
import AppKit
import Foundation

struct Spec: Decodable { let key: String; let name: String; let pt: Double; let weight: String?; let mode: String?; let pad: Double?; let bundle: String?; let scale: Double? }
let args = CommandLine.arguments
let specs = try JSONDecoder().decode([Spec].self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
let weights: [String: NSFont.Weight] = ["ultralight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular, "medium": .medium, "semibold": .semibold, "bold": .bold]
var out: [String: [String: Any]] = [:]
var missing: [String] = []
for s in specs {
    let cfg = NSImage.SymbolConfiguration(pointSize: s.pt, weight: weights[s.weight ?? "regular"] ?? .regular, scale: .medium)
    // system SF Symbol, or a custom symbol from an app's asset catalog (e.g. Music.app's "automix")
    let base: NSImage? = s.bundle.flatMap { Bundle(path: $0) }.flatMap { NSImage(symbolName: s.name, bundle: $0, variableValue: 0) ?? $0.image(forResource: s.name) }
        ?? NSImage(systemSymbolName: s.name, accessibilityDescription: nil)
    guard let img = base?.withSymbolConfiguration(cfg) else { missing.append(s.name); continue }
    let size = img.size
    var cw = size.width, ch = size.height
    if s.mode == "square" { let side = max(s.pt * (s.pad ?? 1.35), size.width, size.height); cw = side; ch = side }
    let scale = CGFloat(s.scale ?? 3)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(ceil(cw * scale)), pixelsHigh: Int(ceil(ch * scale)), bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: cw, height: ch)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(x: (cw - size.width) / 2, y: (ch - size.height) / 2, width: size.width, height: size.height))
    NSGraphicsContext.restoreGraphicsState()
    // ink bounding box (pt), for calibrating optical sizes against screenshots
    var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
    for y in 0..<rep.pixelsHigh { for x in 0..<rep.pixelsWide { if (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.3 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } } }
    let inkW = maxX >= 0 ? Double(maxX - minX + 1) / Double(scale) : 0, inkH = maxY >= 0 ? Double(maxY - minY + 1) / Double(scale) : 0
    let png = rep.representation(using: .png, properties: [:])!
    out[s.key] = ["uri": "data:image/png;base64," + png.base64EncodedString(), "w": (cw * 100).rounded() / 100, "h": (ch * 100).rounded() / 100, "inkW": (inkW * 10).rounded() / 10, "inkH": (inkH * 10).rounded() / 10]
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
try data.write(to: URL(fileURLWithPath: args[2]))
FileHandle.standardError.write("rendered \(out.count), missing: \(missing)\n".data(using: .utf8)!)
