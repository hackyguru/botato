type TextField = HTMLInputElement | HTMLTextAreaElement;
const wired = new WeakSet<TextField>();

function clear(field: TextField): void {
  field.removeAttribute("aria-invalid");
  field.removeAttribute("aria-errormessage");
  document.getElementById(`${field.id}-error`)?.remove();
}

/** Keep a missing-field explanation beside the field until it is edited. */
export function requireText(field: TextField, message: string, valid = Boolean(field.value.trim())): boolean {
  if (valid) {
    clear(field);
    return true;
  }
  const id = `${field.id}-error`;
  let error = document.getElementById(id);
  if (!error) {
    error = document.createElement("p");
    error.id = id;
    error.className = "field-error";
    error.setAttribute("role", "alert");
    (field.closest("label") ?? field).after(error);
  }
  error.textContent = message;
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-errormessage", id);
  if (!wired.has(field)) {
    field.addEventListener("input", () => clear(field));
    wired.add(field);
  }
  field.focus();
  return false;
}

export function clearFormErrors(root: HTMLElement): void {
  for (const field of root.querySelectorAll<TextField>("input[aria-invalid], textarea[aria-invalid]")) clear(field);
}
