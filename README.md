# Character Forge

A browser-based Ragnarok character editor and NPC sprite exporter. Import `data.grf`, choose a job and hair style, equip headgear and garments, preview the job's available actions, and download the **complete animation set** as one native SPR/ACT package.

## Requirements

- A modern browser with JavaScript modules, Canvas, and `DecompressionStream` support, such as Chrome or Edge.
- A Ragnarok client `data.grf` containing character sprites and equipment resources. Game assets are not included in this repository.
- A web server or static hosting service that serves the application over HTTP or HTTPS.

## Installation

1. Clone this repository or download and extract its source archive.
2. Place the application files in your web server's document directory, or upload them to a static hosting service.
3. Preserve the directory structure, including `index.html`, `styles.css`, and the complete `js/` directory with its bundled dependencies.
4. Open the application's address supplied by your web server or hosting service.
5. Select your `data.grf` in the browser to enter the editor.

The application uses static HTML, CSS, and JavaScript. No PHP backend, Node.js runtime, database, dependency installation, or build step is required to run it. All archive parsing, sprite rendering, and export generation happen in the browser.

Serve the files over HTTP or HTTPS instead of opening `index.html` directly from the filesystem. The application can be hosted at a domain root or in a subdirectory; its asset paths are relative.

## Create a character

1. Click **Choose data.grf**, or drop the archive onto the opening screen. The editor stays hidden until a valid archive has been indexed and character resources found.
2. Choose a job, **Male** or **Female**, and a hair style. Only resources found in the selected archive are available.
3. Choose an equipment slot and search by name, item ID or view ID. Add upper, middle or lower headgear, costume headgear, and a garment. Costume pieces replace the corresponding ordinary headgear in the visible composition.
4. Use the **Action** selector to preview Idle, Walking, Sitting, attacks, casting, or any other action available in the selected job. Rotate through available directions, adjust zoom, pause animation or toggle the preview grid.
5. Click **Export NPC sprite**, enter a filename, review the included actions and any equipment availability notes, then **Export all actions**. The preview's selected action does not limit the export.

The import is a local file selection, not a server upload. The browser reads the GRF table and extracts individual resources as needed; it does not read the entire multi-gigabyte archive into memory. No archive or selection is saved to a server or browser storage. Reloading the page requires choosing the archive again. **Change** returns to the import step.

## What the export contains

| File | Contents |
| --- | --- |
| `name.spr` | SPR 2.0 true-color images combined from the selected parts. |
| `name.act` | ACT 2.5 containing every original directional action slot from the selected job, in its original order. |
| `name.json` | Selected parts, action groups and indices, direction order, frame counts, timing, and availability notes. |
| `previews/` | Optional transparent contact sheets, one per action group. Directions are rows and animation frames are columns. |
| `README.txt` | Notes for installing the exported sprite. |

The ZIP is named `name_all_actions.zip`. Export preserves the body's action indices, including empty slots and additional groups found in the archive. A typical player job has 13 groups with eight directions each, for **104 directional actions**. Jobs with more or fewer source slots retain their own layout.

The standard player action groups are Idle, Walking, Sitting, Picking up, Combat ready, Attacking 1, Taking damage, Frozen, Dead, Frozen 2, Attacking 2, Attacking 3, and Casting / skill. Extra groups appear as **Additional action** with their group index. Directions are South, Southwest, West, Northwest, North, Northeast, East and Southeast.

Idle and Sitting use neutral head-look variants and retain built-in equipment animation. Moving and combat actions use the body's full frame sequence and timing, with equipment aligned to the body. Source palettes remain distinct through true-color conversion. Layer offsets, tint, mirroring, rotation and scale are retained; player sound events are omitted.

If an equipped piece or hairstyle has no matching action, it is omitted only from that action and direction. The preview and export dialog display these gaps, and the ZIP records them in its metadata and installation notes. No unrelated pose is substituted. All source body actions remain in the export.

To install an export, keep the matching `.spr` and `.act` together in your client's NPC sprite resource path, normally `data/sprite/npc/`, or pack that path into a GRF. Register the sprite basename with an **unused NPC view ID** in the matching client identity/name tables and configure the server NPC to use that ID. The required table names and valid ID range depend on your client and server. Export does not modify the GRF, client mappings or server configuration. Which animations play in-game depends on the client and server; a stationary NPC will not automatically walk, attack, or cast just because those animations are included. Check the result in your own game client.

## Archive compatibility and import notes

- GRF 2.0 and 3.0 are supported through the GRF reader adapted from Ragnarok Database Builder. Unknown compression or custom protection is reported as an error rather than silently accepted.
- Korean legacy resource paths and readable or supported compiled Lua mapping tables are handled locally. The Lua reader accepts table initialization data; it does not execute arbitrary Lua programs.
- Item names and IDs come from metadata present in the archive. When metadata is absent, a sprite resource name or view ID may be the only available label. Display names are in the archive's language; the app does not translate them.
- Client item metadata often has no structured equipment location. Slot information can be inferred from supported description formats. Custom descriptions or missing metadata can leave a slot unknown; unclassified headgear can be placed manually in the chosen slot. Review the selected pieces in the preview.
- A job or gender may be absent from the archive. Garments can require an ACT file specific to the selected job. Missing pairs or unavailable part actions are reported; the exporter does not fabricate missing directions.
- Only the selected archive is indexed. Resources supplied by another GRF or a loose client `data/` folder are not automatically merged.
- The archive report lists import notes. Very large individual resources, unsafe paths, unsupported binary variants, and excessively large animation combinations are rejected with a message. Native export is limited to 10,000 referenced images and 16 million image pixels; ZIP size is limited to 128 MB. A contact sheet exceeding 8192 pixels on either axis, 32 million pixels, or the remaining ZIP budget is omitted while all native actions remain included. The JSON records any omitted sheets.

## Development checks

Node.js is optional and used only to run the automated checks:

```sh
npm test
```

The tests cover action discovery, animation timing, missing equipment actions, original ACT indices, and native export roundtrips. Set the `GRF_TEST_PATH` environment variable to a client archive to also run the real-archive integration check. No game assets are bundled with the tests.

## Credits and license

GRF parsing, Lua mappings, sprite parsing and rendering logic are adapted from the `ragnarok-database-builder` project, copyright 2026 Manuuuu21, under its MIT license. See [LICENSE](LICENSE), [the reference project's license](js/REFERENCE-LICENSE.txt), and the notices alongside bundled dependencies in `js/vendor/`. Game assets are supplied through the selected archive and are not distributed with this app.
