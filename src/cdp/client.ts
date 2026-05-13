import CDP from "chrome-remote-interface";

export type CdpClient = Awaited<ReturnType<typeof CDP>>;

export async function connectToWsUrl(wsUrl: string): Promise<CdpClient> {
  return await CDP({ target: wsUrl });
}
