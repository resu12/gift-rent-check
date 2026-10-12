// Mirror the production SDK's documented Uint8Array async response body. Tests
// must not pass because of a .text() compatibility path in production code.
export const streamedBody = text => ({async *[Symbol.asyncIterator]() {yield new TextEncoder().encode(text);}});
