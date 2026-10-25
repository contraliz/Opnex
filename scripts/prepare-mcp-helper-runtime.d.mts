export const NODE_RUNTIME_VERSION:string;
export const NODE_RUNTIME_SHA256:Record<string,string>;
export function prepareMcpHelperRuntime(options?:{platform?:string;arch?:string}):Promise<{target:string;version:string;sha256:string}[]>;
