// Standard kRO resource-format key material, documented by GRFEditor:
// https://github.com/Tokeiburu/GRFEditor/blob/master/GRF/Core/GrfHeader.cs
// These are candidates only for the observed legacy kRO key-block variant.
// Each decoded resource must still pass its original XXH128 output checksum.
const keyHex = [
  '2c942196406735fed0c6fc9e15b9480617196b534eaf25ac035081f2b6d4a37151cdaf6847786dd3e404032f8603383ec74920038a9e630407577e0b',
  '2a08da55410a5dd34ab5c1a404b167d9cd6b60e349fa8a6025bd0d282c0550bd4c606759c3dc9eb256b1455b743e81f9bc8a066e76b6054f11c1a301',
  '1e5ab522d97334c99be5413336177abe59e6778ce6d54aa3df2b2656b180defae67c0a11f554ce7615bfe6c41302fe059ce0ec6f59ec7ed3493b3d93',
  '58153206749f6d2a33a20d4e51c7f565b3c804c8d761717664db6b81ddbf54e14b077c728bad590a69e76ea0d3805ccb172835d21aa6ec46fd95298c',
];

function standardKroKeys() {
  return new Map(keyHex.map((hex, index) => [index + 1, Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16))]));
}

// The observed 0x1 key block is not decoded by the supported 0x101 path.
// Its archive keys are NOT decoded or authenticated here. Offer the public kRO
// candidates only for this exact, structurally valid format; the entry decoder
// authenticates every result. Never use this for a corrupt 0x101 key table.
export function kroKeyCandidates(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 20) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const length = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 1 || !length || length % 64 || length > 65535 * 64 || length !== raw.length - 20) return null;
  const keys = standardKroKeys();
  for (const id of keys.keys()) if (id > length / 64) keys.delete(id);
  return keys;
}
