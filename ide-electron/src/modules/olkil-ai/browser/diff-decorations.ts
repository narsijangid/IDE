import { URI } from '@opensumi/ide-core-common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser';
import { computeEditorDiffMarkers, EditorDiffMarkers } from '../common/diff';

const STYLE_ID = 'olkil-ai-diff-styles';

function ensureDiffStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.olkil-diff-add-line {
  background: rgba(46, 160, 67, 0.22) !important;
}
.olkil-diff-add-gutter {
  background: #3fb950;
  width: 4px !important;
  margin-left: 3px;
}
.olkil-diff-del-zone {
  box-sizing: border-box;
  width: 100%;
  overflow: hidden;
  background: rgba(248, 81, 73, 0.16);
  border-left: 3px solid #f85149;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  color: #f85149;
  text-decoration: line-through;
  opacity: 0.92;
  padding: 0 0 0 52px;
  white-space: pre;
}
.olkil-diff-del-zone-row {
  height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;
  document.head.appendChild(style);
}

interface DecorationState {
  path: string;
  modelUri: string;
  decorationIds: string[];
  viewZoneIds: string[];
  markers: EditorDiffMarkers;
  before: string;
  after: string;
}

/**
 * Paints Cursor-like green (added) / red (removed) markers in the live Monaco editor
 * until the user Accepts or Reverts.
 */
export class OlkilDiffDecorationManager {
  private states = new Map<string, DecorationState>();

  constructor(
    private editorService: WorkbenchEditorService,
    private docService: IEditorDocumentModelService,
  ) {
    ensureDiffStyles();
  }

  async apply(changeId: string, filePath: string, before: string, after: string) {
    ensureDiffStyles();
    await this.clear(changeId);

    const markers = computeEditorDiffMarkers(before || '', after || '');
    const uri = URI.file(filePath);
    const ref = await this.docService.createModelReference(uri, 'olkil-ai-diff');
    let decorationIds: string[] = [];
    try {
      const model = ref.instance.getMonacoModel();
      const decorations = markers.addedLines.map((line) => ({
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: 'olkil-diff-add-line',
          linesDecorationsClassName: 'olkil-diff-add-gutter',
          overviewRuler: {
            color: 'rgba(63, 185, 80, 0.85)',
            position: 1, // OverviewRulerLane.Left
          },
          minimap: {
            color: 'rgba(63, 185, 80, 0.85)',
            position: 1,
          },
        },
      }));
      decorationIds = model.deltaDecorations([], decorations as any);
    } finally {
      ref.dispose();
    }

    this.states.set(changeId, {
      path: filePath,
      modelUri: uri.toString(),
      decorationIds,
      viewZoneIds: [],
      markers,
      before,
      after,
    });

    await this.editorService.open(uri, { focus: false });
    this.applyViewZones(changeId);
  }

  /** Re-apply red deleted-line view zones on the currently focused editor for this path. */
  applyViewZones(changeId: string) {
    const state = this.states.get(changeId);
    if (!state) {
      return;
    }
    const editor = this.editorService.currentEditor;
    if (!editor?.monacoEditor) {
      return;
    }
    const currentPath = this.editorService.currentResource?.uri.codeUri.fsPath;
    if (!currentPath || pathEquals(currentPath, state.path) === false) {
      return;
    }

    const monacoEditor = editor.monacoEditor as any;
    // Clear previous zones for this change
    if (state.viewZoneIds.length && monacoEditor.changeViewZones) {
      monacoEditor.changeViewZones((accessor: any) => {
        for (const id of state.viewZoneIds) {
          try {
            accessor.removeZone(id);
          } catch {
            // ignore
          }
        }
      });
      state.viewZoneIds = [];
    }

    if (!state.markers.deletedHunks.length || !monacoEditor.changeViewZones) {
      return;
    }

    const newIds: string[] = [];
    monacoEditor.changeViewZones((accessor: any) => {
      for (const hunk of state.markers.deletedHunks) {
        const dom = document.createElement('div');
        dom.className = 'olkil-diff-del-zone';
        for (const line of hunk.lines.slice(0, 40)) {
          const row = document.createElement('div');
          row.className = 'olkil-diff-del-zone-row';
          row.textContent = line || ' ';
          dom.appendChild(row);
        }
        const id = accessor.addZone({
          afterLineNumber: hunk.afterLineNumber,
          heightInLines: Math.min(hunk.lines.length, 40),
          domNode: dom,
          suppressMouseDown: true,
        });
        newIds.push(id);
      }
    });
    state.viewZoneIds = newIds;
  }

  /** Refresh view zones for whatever file is currently open (call after navigation). */
  refreshForOpenFile() {
    const currentPath = this.editorService.currentResource?.uri.codeUri.fsPath;
    if (!currentPath) {
      return;
    }
    for (const [changeId, state] of this.states) {
      if (pathEquals(state.path, currentPath)) {
        this.applyViewZones(changeId);
      }
    }
  }

  async clear(changeId: string) {
    const state = this.states.get(changeId);
    if (!state) {
      return;
    }

    try {
      const uri = URI.file(state.path);
      const ref = await this.docService.createModelReference(uri, 'olkil-ai-diff-clear');
      try {
        const model = ref.instance.getMonacoModel();
        if (state.decorationIds.length) {
          model.deltaDecorations(state.decorationIds, []);
        }
      } finally {
        ref.dispose();
      }
    } catch {
      // file may have been deleted on revert of create
    }

    const editor = this.editorService.currentEditor;
    const monacoEditor = editor?.monacoEditor as any;
    if (monacoEditor?.changeViewZones && state.viewZoneIds.length) {
      try {
        monacoEditor.changeViewZones((accessor: any) => {
          for (const id of state.viewZoneIds) {
            try {
              accessor.removeZone(id);
            } catch {
              // ignore
            }
          }
        });
      } catch {
        // ignore
      }
    }

    this.states.delete(changeId);
  }

  async clearAll() {
    const ids = [...this.states.keys()];
    for (const id of ids) {
      await this.clear(id);
    }
  }
}

function pathEquals(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
