/**
 * The feature registry — the ONLY place a feature is switched on.
 *
 * Each id is a folder under public/features/<id>/ with a feature.json
 * manifest (see FEATURES.md). Order here is tab order. Remove an id to
 * unplug a feature without deleting it; `scripts/feature-pack.mjs --install`
 * appends ids for imported packs.
 */
export const FEATURES = ['funnel', 'adltv', 'scale', 'health', 'calls', 'paylinks'];
