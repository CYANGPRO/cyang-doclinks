const opaqueStorageKey = /^local801\/(documents|imports|reports)\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/i;

export function getBoundedListedObjects(contents, batchSize) {
  if (!Array.isArray(contents) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000
    || contents.length > batchSize) {
    throw new Error("Retention object inventory is outside the reviewed bound.");
  }
  const listed = [];
  const keys = new Set();
  for (const entry of contents) {
    if (!entry || typeof entry.Key !== "string" || !opaqueStorageKey.test(entry.Key)
      || !Number.isSafeInteger(entry.Size) || entry.Size < 0 || keys.has(entry.Key)) {
      throw new Error("Retention object inventory contains an invalid or duplicate opaque object.");
    }
    keys.add(entry.Key);
    listed.push(Object.freeze({ key: entry.Key, byteSize: entry.Size }));
  }
  return Object.freeze(listed);
}

export function findUnreferencedListedObjects(listed, referencedKeys) {
  const listedKeys = new Set(listed.map((entry) => entry.key));
  const referenced = new Set();
  for (const value of referencedKeys) {
    if (typeof value !== "string" || !listedKeys.has(value)) {
      throw new Error("Retention database reference escaped the bounded object page.");
    }
    referenced.add(value);
  }
  return Object.freeze(listed.filter((entry) => !referenced.has(entry.key)));
}

export const __testing = { opaqueStorageKey };
