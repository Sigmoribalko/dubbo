/** Save a blob as a file. Uses the host's download capability when embedded, otherwise a plain link. */
export async function saveFile(name: string, blob: Blob): Promise<"saved" | "declined"> {
  const host = (window as unknown as { claude?: { use?: (c: string) => Promise<{ save(o: { filename: string; data: Blob }): Promise<void> }> } }).claude;
  if (host?.use) {
    try {
      const dl = await host.use("downloads");
      await dl.save({ filename: name, data: blob });
      return "saved";
    } catch (e) {
      if ((e as { code?: string })?.code === "declined") return "declined";
      // fall through to the link approach
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return "saved";
}
