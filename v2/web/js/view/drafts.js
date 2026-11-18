/**
 * The settings form's drafts (B-176, preview rules 4 and 5): what the user
 * typed, numbered. Every edit raises the draft number; a preview request
 * carries the newest draft with every valid edit, and Save names the draft
 * it commits. What was typed after a Save was sent stays, and is previewed
 * again with a higher draft.
 *
 * The draft number is the page's edit counter (section 6, PUT …/preview):
 * pixdcon keeps the last draft it took per page session, device and scene,
 * and a request with a draft that is not newer changes nothing. So the
 * number is not the form's: one counter serves every form of the page, and
 * it keeps rising when a form goes and another comes (the device page is
 * left and opened again, the scene is switched). A form that started again
 * at 1 would send drafts pixdcon has already seen.
 *
 * An edit has an identity, its draft number. What an answer says about an
 * edit (Save committed it, the preview rejected it) is applied to the edit
 * with that number only; an edit typed after the request left has a newer
 * number and is not touched, whatever it reads.
 *
 * The fields show the form's own edits for as long as they are not saved
 * or reverted, so an answer for an older draft never puts an older value
 * into a field the user is editing; what the store holds (decideView: rev
 * inside the device's life) is shown for every other field.
 *
 * Pure: no DOM. components/settings-form.js keeps one book per scene it
 * shows; test/contract/client.test.js runs it in Node.
 *
 * Owner: UI worker.
 */

/**
 * @typedef {object} Edit
 * @property {string} raw what is in the field
 * @property {unknown} [value] the parsed value, when it parses
 * @property {string} [error] why it does not parse, or why pixdcon rejected it; such an edit is never previewed or saved
 * @property {boolean} [refused] the error is pixdcon's reason: the preview's answer refused the value (Tick Q2: "pixdcon refused this value: <reason>")
 * @property {number} draft the draft number of this edit: its identity
 */

/** The page's edit counter: the last draft number handed out, by any form. */
let pageDraft = 0;

export function createDraftBook() {
  /** The newest draft number of this book's edits; 0 before the first. */
  let draft = 0;
  /** @type {Map<string, Edit>} */
  const edits = new Map();
  /** Keys whose saved value is removed on Save (Reset to default, B-086). @type {Set<string>} */
  const resets = new Set();

  return {
    edits,
    resets,
    /** @returns {number} the newest draft number of this form */
    draft: () => draft,
    /** Historical book-based feedback identity: retained for tests and the
     * M1 regression mutant. The form uses its scheduled preview identity. */
    feedbackDraft: () => edits.size > 0 ? draft : 0,
    /** A new definition needs a new preview, retaining each edit's identity. */
    revalidate() {
      draft = ++pageDraft;
      for (const edit of edits.values())
        if (edit.refused) {
          delete edit.error;
          delete edit.refused;
        }
    },
    /**
     * A field changed.
     *
     * @param {string} key
     * @param {string} raw
     * @param {{value?: unknown, error?: string}} parsed
     * @returns {number} the draft number of this edit
     */
    edit(key, raw, parsed) {
      draft = ++pageDraft;
      edits.set(key, { raw, ...parsed, draft });
      resets.delete(key);
      return draft;
    },
    /**
     * "Reset to default": the default is previewed now and the saved value
     * removed on the next Save.
     *
     * @param {string} key
     * @param {unknown} value the default
     * @param {string} raw how the field shows it
     * @returns {number}
     */
    reset(key, value, raw) {
      draft = ++pageDraft;
      edits.set(key, { raw, value, draft });
      resets.add(key);
      return draft;
    },
    /** @returns {Array<[string, Edit]>} the edits that do not parse */
    errors() {
      return [...edits].filter(([, edit]) => edit.error !== undefined);
    },
    /** @returns {number} unsaved changes: edits and resets */
    changes() {
      return edits.size + [...resets].filter((key) => !edits.has(key)).length;
    },
    /**
     * The body of PUT …/preview: the newest draft and every edit that parses.
     *
     * @param {string} session
     * @returns {{session: string, draft: number, values: Record<string, unknown>}}
     */
    previewBody(session) {
      return this.previewPlan(session).body;
    },
    /**
     * The preview request and the identity of every edit it carries.
     *
     * @param {string} session
     * @returns {{body: {session: string, draft: number, values: Record<string, unknown>}, sent: Map<string, number>}} sent: key → draft of the edit that was sent
     */
    previewPlan(session) {
      /** @type {Record<string, unknown>} */
      const values = {};
      /** @type {Map<string, number>} */
      const sent = new Map();
      for (const [key, edit] of edits)
        if (edit.error === undefined) {
          values[key] = edit.value;
          sent.set(key, edit.draft);
        }
      return { body: { session, draft, values }, sent };
    },
    /**
     * The preview's answer named values that pixdcon did not take
     * (`rejected`). The reason goes to the edit that was sent, and to no
     * edit typed since.
     *
     * @param {Map<string, number>} sent what previewPlan said was sent
     * @param {Record<string, unknown>|null|undefined} reasons key → why
     */
    rejected(sent, reasons) {
      for (const [key, reason] of Object.entries(reasons ?? {})) {
        const edit = edits.get(key);
        if (edit && edit.draft === sent.get(key)) {
          edit.error = typeof reason === "string" ? reason.trim() : "";
          edit.refused = true;
        }
      }
    },
    /**
     * The body of PUT …/settings/<scene> (Save), and what it commits; null
     * while an edit does not parse (Save is blocked, S-5).
     *
     * @param {string|null} session
     * @returns {{body: {set: Record<string, unknown>, reset: string[], session?: string, draft?: number}, committed: Map<string, number>}|null} committed: key → draft of the edit that is saved
     */
    saveBody(session) {
      if (this.errors().length > 0) return null;
      /** @type {Record<string, unknown>} */
      const set = {};
      /** @type {Map<string, number>} */
      const committed = new Map();
      for (const [key, edit] of edits) {
        committed.set(key, edit.draft);
        if (!resets.has(key)) set[key] = edit.value;
      }
      return {
        body: { set, reset: [...resets], ...(session ? { session, draft } : {}) },
        committed,
      };
    },
    /**
     * Save was answered: what it committed leaves the form, what was typed
     * after the click stays (and is previewed again with a newer draft).
     *
     * @param {Map<string, number>} committed key → draft of the edit that was saved; an edit with another draft was typed after the click and stays, whatever it reads
     * @param {string[]} reset
     */
    saved(committed, reset) {
      for (const [key, number] of committed) if (edits.get(key)?.draft === number) edits.delete(key);
      for (const key of reset) if (!edits.has(key)) resets.delete(key);
    },
    /** Revert: nothing typed is kept. The page's draft number keeps rising. */
    clear() {
      edits.clear();
      resets.clear();
    },
    /**
     * What a field shows: the edit while there is one, else the value in
     * effect as the store holds it.
     *
     * @param {string} key
     * @param {{effective?: unknown}|undefined} layer the SettingValue the store holds
     * @returns {{raw?: string, value: unknown, error?: string}}
     */
    shown(key, layer) {
      const edit = edits.get(key);
      if (edit) return { raw: edit.raw, value: edit.value, error: edit.error };
      return { value: layer?.effective };
    },
  };
}
