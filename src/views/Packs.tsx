import { useCallback, useEffect, useState } from "react";
import { FileButton } from "../components/FileButton";
import { Icon } from "../components/Icon";
import { Menu } from "../components/Menu";
import { Modal } from "../components/Modal";
import { exportPack } from "../lib/pack/export";
import { ImportError, importFiles } from "../lib/pack/import";
import { store } from "../lib/store";
import type { Pack } from "../lib/types";
import { uid } from "../lib/util";
import { useT, type Dict } from "../i18n";
import { notify, useApp } from "../state/app";

type ImportState =
  | { kind: "busy" }
  | { kind: "done"; pack: Pack }
  | { kind: "error"; title: string; text: string; paths?: string[] };

export function Packs() {
  const t = useT();
  const go = useApp((s) => s.go);
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
      <div className="page-head">
        <div>
          <h2>{t.packs.title}</h2>
          <p className="muted">{t.packs.lead}</p>
        </div>
        <div className="row">
          <button onClick={newPack}><Icon name="plus" />{t.packs.newPack}</button>
          <Menu className="primary" label={<><Icon name="upload" />{t.packs.import}</>}>
            <FileButton className="menu-item" multiple onFiles={runImport}>{t.home.importFiles}</FileButton>
            <FileButton className="menu-item" directory onFiles={runImport}>{t.home.importFolder}</FileButton>
          </Menu>
        </div>
      </div>

      {packs && !packs.length && (
        <div className="empty-state">
          <p><b>{t.packs.emptyTitle}</b></p>
          <p className="muted">{t.packs.emptyText}</p>
        </div>
      )}
      <div className="pack-grid">
        {packs?.map((p, i) => (
          <article className="pack-card rise" style={{ ["--i" as string]: i }} key={p.id}>
            <div className="pack-cover" aria-hidden="true"><Icon name="film" size={28} /></div>
            <div className="pack-body">
              <h3>{p.name || t.common.untitled}</h3>
              <p className="muted fine">{t.home.packMeta(p.scenes.length, p.author)}</p>
            </div>
            <div className="pack-actions">
              <button className="small primary" disabled={!p.scenes.length} onClick={() => go({ name: "online", intent: "create", packId: p.id })}>{t.common.play}</button>
              <Menu className="small ghost icon-only" ariaLabel={t.packs.more} label={<Icon name="dots" />}>
                <button className="menu-item" onClick={() => go({ name: "editor", packId: p.id })}>{t.common.edit}</button>
                <button className="menu-item" onClick={() => doExport(p)}>{t.common.export}</button>
                <button className="menu-item danger" onClick={() => remove(p)}>{t.common.delete}</button>
              </Menu>
            </div>
          </article>
        ))}
      </div>

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
