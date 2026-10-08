import { useCallback, useEffect, useMemo, useState } from "react";
import { Band } from "../components/Band";
import { FileButton } from "../components/FileButton";
import { Modal } from "../components/Modal";
import { exportPack } from "../lib/pack/export";
import { ImportError, importFiles } from "../lib/pack/import";
import { store } from "../lib/store";
import type { Pack } from "../lib/types";
import { colorFor, prefersReducedMotion, uid } from "../lib/util";
import { useT, type Dict } from "../i18n";
import { notify, useApp } from "../state/app";

const DEMO_TIMING = [
  { roleId: "a", start: 0.6, end: 2.6 },
  { roleId: "b", start: 3, end: 5 },
  { roleId: "c", start: 5.4, end: 6.8 },
  { roleId: "a", start: 7.2, end: 9.6 },
  { roleId: "c", start: 10, end: 12.4 },
  { roleId: "b", start: 12.8, end: 15 },
];
const demoStart = performance.now();
const demoTime = () => (prefersReducedMotion() ? 3.6 : ((performance.now() - demoStart) / 1000) % 16);

type ImportState =
  | { kind: "busy" }
  | { kind: "done"; pack: Pack }
  | { kind: "error"; title: string; text: string; paths?: string[] };

export function Home() {
  const t = useT();
  const go = useApp((s) => s.go);
  const demo = useMemo(() => ({
    roles: t.home.demo.roles.map((name, i) => ({ id: "abc"[i], name, color: colorFor(i) })),
    lines: DEMO_TIMING.map((l, i) => ({ ...l, id: String(i), text: t.home.demo.lines[i] })),
  }), [t]);
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [imp, setImp] = useState<ImportState | null>(null);

  const refresh = useCallback(() => { store.listPacks().then(setPacks); }, []);
  useEffect(refresh, [refresh]);

  const newPack = async () => {
    const p: Pack = { id: uid(), name: t.editor.newPackName, scenes: [], updated: Date.now() };
    await store.putPack(p);
    go({ name: "editor", packId: p.id });
  };

  const runImport = async (files: File[]) => {
    setImp({ kind: "busy" });
    try {
      const [pack] = await importFiles(files);
      setImp({ kind: "done", pack });
      refresh();
    } catch (e) {
      const m = t.importer;
      if (e instanceof ImportError && e.kind === "rar") setImp({ kind: "error", title: m.rarTitle, text: m.rarText });
      else if (e instanceof ImportError && e.kind === "novideo") setImp({ kind: "error", title: m.noVideoTitle, text: m.noVideoText, paths: e.paths });
      else if (e instanceof ImportError && e.kind === "zip") setImp({ kind: "error", title: m.zipTitle, text: m.zipText });
      else {
        console.error(e);
        setImp({ kind: "error", title: m.failTitle, text: m.failText });
      }
    }
  };

  const remove = async (p: Pack) => {
    if (!confirm(t.home.confirmDelete(p.name))) return;
    await store.deletePack(p);
    refresh();
  };

  const doExport = async (p: Pack) => {
    if (!p.scenes.length) return notify(t.exporter.noScenes);
    notify(t.exporter.building);
    try { if ((await exportPack(p)) === "saved") notify(t.exporter.saved); }
    catch { notify(t.exporter.failed); }
  };

  return (
    <div className="wrap stack">
      <div className="hero stack">
        <h1>{t.home.title}</h1>
        <p>{t.home.lead}</p>
        <Band lines={demo.lines} roles={demo.roles} duration={16} time={demoTime} label={t.home.demoLabel} />
        <div className="row">
          <button className="primary" onClick={() => go({ name: "online", intent: "create" })}>{t.home.newGame}</button>
          <button onClick={() => go({ name: "online", intent: "find" })}>{t.home.findGame}</button>
          <button onClick={() => go({ name: "online", intent: "join" })}>{t.home.joinGame}</button>
          <button onClick={newPack}>{t.home.createPack}</button>
          <FileButton multiple onFiles={runImport}>{t.home.importFiles}</FileButton>
          <FileButton directory onFiles={runImport}>{t.home.importFolder}</FileButton>
        </div>
      </div>

      <section className="panel" aria-labelledby="packs-h">
        <h3 id="packs-h" style={{ marginBottom: 6 }}>{t.home.yourPacks}</h3>
        {packs && !packs.length && <p className="muted">{t.home.noPacks}</p>}
        {packs?.map((p, i) => (
          <div className="pack rise" style={{ ["--i" as string]: i }} key={p.id}>
            <div className="pack-name">
              {p.name || t.common.untitled}
              <small>{t.home.packMeta(p.scenes.length, p.author)}</small>
            </div>
            <button className="small primary" disabled={!p.scenes.length} onClick={() => go({ name: "online", intent: "create", packId: p.id })}>{t.common.play}</button>
            <button className="small" onClick={() => go({ name: "editor", packId: p.id })}>{t.common.edit}</button>
            <button className="small" onClick={() => doExport(p)}>{t.common.export}</button>
            <button className="small ghost danger" onClick={() => remove(p)}>{t.common.delete}</button>
          </div>
        ))}
      </section>

      <ol className="steps">
        {t.home.steps.map(([title, text]) => <li key={title}><b>{title}</b><br /><span className="muted">{text}</span></li>)}
      </ol>

      {imp?.kind === "busy" && (
        <Modal title={t.importer.busyTitle}>
          <div className="row"><div className="spinner" /><span className="muted">{t.importer.busyText}</span></div>
        </Modal>
      )}
      {imp?.kind === "done" && <ImportDone t={t} pack={imp.pack} onClose={() => setImp(null)} onPlay={() => go({ name: "online", intent: "create", packId: imp.pack.id })} />}
      {imp?.kind === "error" && (
        <Modal
          title={imp.title}
          onClose={() => setImp(null)}
          actions={<>
            {imp.paths && <button onClick={() => navigator.clipboard.writeText(imp.paths!.join("\n")).then(() => notify(t.importer.copied), () => notify(t.importer.copyFailed))}>{t.importer.copyList}</button>}
            <button className="primary" onClick={() => setImp(null)}>{t.common.ok}</button>
          </>}
        >
          <p>{imp.text}</p>
          {imp.paths && <pre className="diag">{imp.paths.slice(0, 80).join("\n") || t.importer.empty}{imp.paths.length > 80 ? "\n" + t.importer.more(imp.paths.length - 80) : ""}</pre>}
        </Modal>
      )}
    </div>
  );
}

function ImportDone({ t, pack, onClose, onPlay }: { t: Dict; pack: Pack; onClose(): void; onPlay(): void }) {
  const lines = pack.scenes.reduce((n, s) => n + s.lines.length, 0);
  const noLines = pack.scenes.filter((s) => !s.lines.length).length;
  const ogv = pack.scenes.some((s) => s.ext === "ogv");
  return (
    <Modal title={t.importer.doneTitle(pack.name)} onClose={onClose} actions={<><button onClick={onClose}>{t.common.close}</button><button className="primary" onClick={onPlay}>{t.common.play}</button></>}>
      <p>{t.importer.doneStats(pack.scenes.length, lines, pack.scenes.some((s) => s.bg))}</p>
      {noLines > 0 && <p className="muted">{t.importer.noLines(noLines === pack.scenes.length)}</p>}
      {ogv && <p className="muted">{t.importer.ogv}</p>}
    </Modal>
  );
}
