// Talks to Apple Notes for Outline. The app runs it as:
//   osascript -l JavaScript notes.js <send|fetch> <input.json> <output.json>
// send  input { folder, notes: [{ id, appleId, html }] }
//       output { account, notes: [{ id, appleId, name, html, modified }] }
// fetch input { folder }
//       output { account, notes: [{ appleId, name, html, modified }] }
ObjC.import('Foundation');

function readText(path) {
  return $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
}

function writeText(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function folderNamed(Notes, name, create) {
  const account = Notes.defaultAccount();
  const found = account.folders.whose({ name: name })();
  if (found.length) return found[0];
  if (!create) return null;
  Notes.make({ new: 'folder', at: account, withProperties: { name: name } });
  return account.folders.whose({ name: name })()[0];
}

// A note Outline sent before — unless it has been deleted in Apple Notes since.
function existingNote(Notes, appleId) {
  if (!appleId) return null;
  try {
    const note = Notes.notes.byId(appleId);
    return note.container().name() === 'Recently Deleted' ? null : note;
  } catch (e) {
    return null;
  }
}

function run(argv) {
  const action = argv[0];
  const input = JSON.parse(readText(argv[1]));
  const Notes = Application('Notes');
  const account = Notes.defaultAccount().name();
  let out;

  if (action === 'send') {
    const folder = folderNamed(Notes, input.folder, true);
    out = {
      account: account,
      notes: input.notes.map(function (n) {
        let note = existingNote(Notes, n.appleId);
        if (note) note.body = n.html;
        else note = Notes.make({ new: 'note', at: folder, withProperties: { body: n.html } });
        // html = what Apple Notes actually stored, so Outline can later tell a real edit from a re-save
        return { id: n.id, appleId: note.id(), name: note.name(), html: note.body(), modified: note.modificationDate().toISOString() };
      }),
    };
  } else if (action === 'fetch') {
    const folder = folderNamed(Notes, input.folder, false);
    if (!folder) out = { account: account, notes: [] };
    else {
      const ids = folder.notes.id();
      const names = folder.notes.name();
      const bodies = folder.notes.body();
      const modified = folder.notes.modificationDate();
      out = {
        account: account,
        notes: ids.map(function (id, i) {
          return { appleId: id, name: names[i], html: bodies[i], modified: modified[i].toISOString() };
        }),
      };
    }
  } else {
    throw new Error('Unknown action: ' + action);
  }

  writeText(argv[2], JSON.stringify(out));
}
