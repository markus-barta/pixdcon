/**
 * Component: scene settings (heading band and rows).
 *
 * Heading band: title "Settings · <scene>", one description line, and a fixed
 * 340 px block with the slots [Clear N overlays] [Revert] [Save] and a
 * two-line status. Empty slots keep their width, so Save never moves.
 * Rows from the schema in v1's group order: label with range, control by
 * type, and a marker: default · saved (+ "Reset to default") · violet "from
 * MQTT overlay · saved 19" · blue "previewing · was 30".
 *
 * Behaviour (approved spec section 8, build rules 1 and 2):
 *  - a changed field is previewed on the display at once (PUT …/preview with
 *    this page's session); Revert and leaving the page end the preview
 *  - Save sends only the changed keys; while it runs the button shows its busy
 *    label and takes no second click, the fields stay editable, and edits made
 *    meanwhile become a new preview instead of being thrown away
 *  - a JSON field that does not parse shows its error in its reserved line, is
 *    not previewed and blocks Save (mockup pixd-device-json-error)
 *  - while the values of a newly chosen scene are loading: the heading stays
 *    and "Loading settings for <scene>" stands in the form's place; on
 *    failure "Settings could not be loaded" with Retry. Never an empty form.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/**
 * @param {HTMLElement} host
 * @param {{device: string, session: string}} options
 * @returns {{setScene: (scene: string|null) => void, update: (settingsState: any) => void, destroy: () => void}}
 */
export function createSettingsForm(host, options) {
  return todo("components/settings-form.createSettingsForm", host, options);
}
