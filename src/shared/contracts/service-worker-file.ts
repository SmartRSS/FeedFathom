export const serviceWorkerFile = (hash: string) => `sw-${hash}.js`;
export const serviceWorkerPathPattern = /^\/sw-[a-f0-9]+\.js$/;
