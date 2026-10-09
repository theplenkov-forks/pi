import { stream, streamSimple } from "./api.ts";
import { fetchAcpSessionInfo } from "./pool.ts";

export const acpApiModule = {
	stream,
	streamSimple,
};

export { fetchAcpSessionInfo as acpDiscoveryFn };
