// "Neue Aufgabe" dialog: pick a taskgroup, validate the name against the global part
// namespace, optionally create the matching altdir file too.

import type { CourseIndex } from "../backend";
import { PART_NAME_RE, partNames } from "../course";
import { de } from "../i18n/de";
import { h, showDialog } from "../ui/dom";

export interface NewTaskRequest {
  chapter: string;
  taskgroup: string;
  name: string;
  withAltdir: boolean;
}

export function validateTaskName(name: string, taken: Set<string>): string | null {
  if (!name) return de.newTask.emptyName;
  if (!PART_NAME_RE.test(name)) return de.newTask.invalidName;
  if (taken.has(name)) return de.newTask.duplicate(name);
  return null;
}

export async function newTaskDialog(index: CourseIndex, preselect: { chapter: string; taskgroup: string } | null): Promise<NewTaskRequest | null> {
  const taken = partNames(index);
  const select = h("select", {});
  for (const ch of index.chapters) {
    const og = h("optgroup", { label: ch.part.title ? `${ch.part.name}: ${ch.part.title}` : ch.part.name });
    for (const tg of ch.taskgroups) {
      const opt = h("option", { value: `${ch.part.name}/${tg.part.name}` }, tg.part.title ? `${tg.part.name}: ${tg.part.title}` : tg.part.name);
      if (preselect && preselect.chapter === ch.part.name && preselect.taskgroup === tg.part.name) opt.selected = true;
      og.append(opt);
    }
    select.append(og);
  }
  const nameInput = h("input", { type: "text", spellcheck: "false", autocomplete: "off" });
  const alt = h("input", { type: "checkbox" });
  alt.checked = index.altdirAvailable;
  alt.disabled = !index.altdirAvailable;
  const error = h("div", { class: "form-error" });
  const files = h("ul", { class: "form-files" });
  const body = h(
    "div",
    { class: "form" },
    h("label", {}, de.newTask.taskgroup, select),
    h("label", {}, de.newTask.name, nameInput),
    error,
    h("label", { class: "checkbox" }, alt, index.altdirAvailable ? de.newTask.withAltdir : de.newTask.altdirMissing),
    h("div", { class: "form-hint" }, de.newTask.filesToCreate),
    files,
  );
  let createBtn: HTMLButtonElement | null = null;
  const chapterdirRel = index.chapters[0]?.part.rel.split("/")[0] ?? "ch";
  const update = () => {
    const name = nameInput.value.trim();
    const msg = validateTaskName(name, taken);
    error.textContent = name ? (msg ?? "") : "";
    if (createBtn) createBtn.disabled = msg !== null;
    const [chapter, tg] = select.value.split("/");
    const fname = `${name || "…"}.md`;
    const list = [`${chapterdirRel}/${chapter}/${tg}/${fname}`];
    if (alt.checked && index.config.altdir) list.push(`altdir: ${chapter}/${tg}/${fname}`);
    files.replaceChildren(...list.map((f) => h("li", {}, f)));
  };
  nameInput.addEventListener("input", update);
  select.addEventListener("change", update);
  alt.addEventListener("change", update);

  const ok = await showDialog({
    title: de.newTask.title,
    body,
    buttons: [
      { label: de.common.cancel, value: false },
      { label: de.newTask.create, value: true, primary: true },
    ],
    cancelValue: false,
    onOpen: (root) => {
      createBtn = root.querySelector("button.primary");
      update();
      nameInput.focus();
    },
  });
  if (!ok) return null;
  const [chapter, taskgroup] = select.value.split("/");
  return { chapter, taskgroup, name: nameInput.value.trim(), withAltdir: alt.checked && !alt.disabled };
}
