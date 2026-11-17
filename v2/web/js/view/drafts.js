/**
 * The settings form's drafts (B-176, preview rules 4 and 5): what the user
 * typed, numbered. Every edit raises the form's draft number; a preview
 * request carries the newest draft with every valid edit, and Save names
 * the draft it commits. What was typed after a Save was sent stays, and is
 * previewed again with a higher draft.
 *
 * The fields show the form's own edits for as long as they are not saved
 * or reverted, so an answer for an older draft never puts an older value
 * into a field the user is editing; what the store holds (decideView: rev
 * inside the device's life) is shown for every other field.
 *
 * Pure: no DOM. components/settings-form.js keeps one book per form;
 * test/contract/client.test.js runs it in Node.
 *
 * Owner: UI worker.
 */

/**
 * @typedef {object} Edit
 * @property {string} raw what is in the field
 * @property {unknown} [value] the parsed value, when it parses
 * @property {string} [error] why it does not parse; such an edit is never previewed or saved
 * @property {number} draft the draft number of this edit
 */

export function createDraftBook() {
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
    /**
     * A field changed.
     *
     * @param {string} key
     * @param {string} raw
     * @param {{value?: unknown, error?: string}} parsed
     * @returns {number} the draft number of this edit
     */
    edit(key, raw, parsed) {
      draft += 1;
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
      draft += 1;
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
      /** @type {Record<string, unknown>} */
      const values = {};
      for (const [key, edit] of edits) if (edit.error === undefined) values[key] = edit.value;
      return { session, draft, values };
    },
    /**
     * The body of PUT …/settings/<scene> (Save), and what it commits; null
     * while an edit does not parse (Save is blocked, S-5).
     *
     * @param {string|null} session
     * @returns {{body: {set: Record<string, unknown>, reset: string[], session?: string, draft?: number}, committed: Map<string, string>}|null}
     */
    saveBody(session) {
      if (this.errors().length > 0) return null;
      /** @type {Record<string, unknown>} */
      const set = {};
      /** @type {Map<string, string>} */
      const committed = new Map();
      for (const [key, edit] of edits) {
        committed.set(key, edit.raw);
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
     * @param {Map<string, string>} committed key → the raw text that was saved
     * @param {string[]} reset
     */
    saved(committed, reset) {
      for (const [key, raw] of committed) if (edits.get(key)?.raw === raw) edits.delete(key);
      for (const key of reset) if (!edits.has(key)) resets.delete(key);
    },
    /** Revert, or another scene: nothing typed is kept. The draft number keeps rising. */
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
