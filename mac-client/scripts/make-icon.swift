import AppKit
let out=CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath:out,withIntermediateDirectories:true)
for size in [16,32,128,256,512] {
    for scale in [1,2] {
        let pixels=size*scale
        let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:pixels*4,bitsPerPixel:32)!
        NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
        NSColor(calibratedRed:0.14,green:0.44,blue:0.33,alpha:1).setFill()
        let pad=CGFloat(pixels)*0.05
        NSBezierPath(roundedRect:NSRect(x:pad,y:pad,width:CGFloat(pixels)-2*pad,height:CGFloat(pixels)-2*pad),xRadius:CGFloat(pixels)*0.2,yRadius:CGFloat(pixels)*0.2).fill()
        NSColor.white.setStroke();let line=NSBezierPath();line.lineWidth=CGFloat(pixels)*0.07;line.lineCapStyle = .round
        let a=CGFloat(pixels)*0.3,b=CGFloat(pixels)*0.7
        line.move(to:NSPoint(x:a,y:a));line.line(to:NSPoint(x:b,y:b));line.move(to:NSPoint(x:a,y:b));line.line(to:NSPoint(x:b,y:b));line.line(to:NSPoint(x:b,y:a));line.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let suffix=scale==2 ? "@2x":""
        try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:out+"/icon_\(size)x\(size)\(suffix).png"))
    }
}
