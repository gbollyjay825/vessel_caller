/* ============================================================
   dom.js — tiny hyperscript + DOM helpers (zero dependencies).

   h('div.card#main', { onClick, style:{}, 'aria-label':'x' }, child, [children])
   - tag string supports .class and #id shorthand
   - props is optional; second arg may be a child/array instead
   - children may be nodes, strings, numbers, arrays, or falsy (skipped)
   ============================================================ */

function parseTag(tag) {
  let name = "div";
  const classes = [];
  let id = null;
  for (const part of tag.split(/(?=[.#])/)) {
    if (!part) continue;
    if (part[0] === ".") classes.push(part.slice(1));
    else if (part[0] === "#") id = part.slice(1);
    else name = part;
  }
  return { name, classes, id };
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;

    if (k === "class" || k === "className") {
      const next = String(v).trim();
      el.className = el.className ? `${el.className} ${next}` : next;
    } else if (k === "style") {
      if (typeof v === "string") el.style.cssText = v;
      else Object.assign(el.style, v);
    } else if (k === "dataset") {
      Object.assign(el.dataset, v);
    } else if (k === "html" || k === "innerHTML") {
      el.innerHTML = v;
    } else if (k === "ref" && typeof v === "function") {
      v(el);
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in el && k !== "list" && k !== "form" && k !== "type") {
      // Prefer the DOM property when one exists (value, checked, disabled…)
      try {
        el[k] = v;
      } catch {
        el.setAttribute(k, v === true ? "" : v);
      }
    } else {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true || c === "") continue;
    if (Array.isArray(c)) {
      appendChildren(el, c);
    } else if (c instanceof Node) {
      el.appendChild(c);
    } else {
      el.appendChild(document.createTextNode(String(c)));
    }
  }
}

export function h(tag, props, ...children) {
  const el =
    typeof tag === "string"
      ? (() => {
          const { name, classes, id } = parseTag(tag);
          const node = document.createElement(name);
          if (classes.length) node.classList.add(...classes);
          if (id) node.id = id;
          return node;
        })()
      : tag;

  // Allow props to be omitted: h('div', childOrArray, ...)
  if (
    props != null &&
    (props instanceof Node || Array.isArray(props) || typeof props !== "object")
  ) {
    children.unshift(props);
    props = null;
  }
  if (props) applyProps(el, props);
  appendChildren(el, children);
  return el;
}

/** Replace all children of `parent` with `node(s)`. */
export function setChildren(parent, node) {
  parent.replaceChildren();
  appendChildren(parent, [node]);
  return parent;
}

/** Remove all children. */
export function clear(el) {
  el.replaceChildren();
  return el;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Convenience text node. */
export const t = (str) => document.createTextNode(String(str));
