/**
 * MP3 duration by walking MPEG audio frame headers (handles VBR and ID3v2).
 * Used to size the autopilot montage to the exact voiceover length without
 * shelling out to ffprobe from the orchestrator.
 */

const BITRATES: Record<string, number[]> = {
  // [version][layer] → kbps by index (index 0 = free, 15 = bad)
  'V1L1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'V1L2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'V1L3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'V2L1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'V2L2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'V2L3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

export function mp3DurationSec(buf: Buffer): number {
  let i = 0;
  // Skip ID3v2 tag
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }

  let seconds = 0;
  let frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (buf[i + 1] >> 3) & 0x03; // 3=V1, 2=V2, 0=V2.5, 1=reserved
    const layerBits = (buf[i + 1] >> 1) & 0x03; // 3=L1, 2=L2, 1=L3
    const brIdx = (buf[i + 2] >> 4) & 0x0f;
    const srIdx = (buf[i + 2] >> 2) & 0x03;
    const padding = (buf[i + 2] >> 1) & 0x01;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }

    const layer = 4 - layerBits; // 1..3
    const v1 = verBits === 3;
    const kbps = BITRATES[`${v1 ? 'V1' : 'V2'}L${layer}`][brIdx];
    const sr = SAMPLE_RATES[verBits][srIdx];
    const samples = layer === 1 ? 384 : layer === 2 ? 1152 : v1 ? 1152 : 576;
    const frameLen = layer === 1
      ? Math.floor((12 * kbps * 1000) / sr + padding) * 4
      : Math.floor(((samples / 8) * kbps * 1000) / sr) + padding;
    if (frameLen < 4) { i++; continue; }

    seconds += samples / sr;
    frames++;
    i += frameLen;
  }
  return frames > 0 ? Math.round(seconds * 100) / 100 : 0;
}
