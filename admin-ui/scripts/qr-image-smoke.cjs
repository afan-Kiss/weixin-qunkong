const { app, nativeImage } = require('electron')
const path = require('path')
const { decodeNativeImages, classifyQrText, nativeImageRgba } = require('../electron/qr-collector.cjs')
const zbarRoot = path.dirname(require.resolve('@undecaf/zbar-wasm/package.json'))
const zbar = require(path.join(zbarRoot, 'dist', 'inlined', 'main.cjs'))

app.whenReady().then(async () => {
  let failed = false
  for (const file of process.argv.slice(2)) {
    const image = nativeImage.createFromPath(file)
    const values = await decodeNativeImages(image)
    const pixels = nativeImageRgba(image)
    const rawSymbols = pixels ? await zbar.scanRGBABuffer(pixels.rgba.buffer, pixels.width, pixels.height) : []
    console.log(JSON.stringify({ file, size: pixels ? `${pixels.width}x${pixels.height}` : 'empty', symbols: rawSymbols.map((item) => ({ type: item.typeName, text: item.decode() })), codes: values.map((text) => ({ type: classifyQrText(text), text })) }, null, 2))
    if (!values.length) failed = true
  }
  app.exit(failed ? 1 : 0)
}).catch((error) => { console.error(error); app.exit(1) })
