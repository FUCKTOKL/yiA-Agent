/* DOM 工具：全项目共享 */

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const esc = s => String(s).replace(/</g, '&lt;');

/* 受控 HTML 渲染：DOMParser 注入（解析器文档中的脚本不执行，天然防注入）。
   数据侧仍须走 esc()，二者配合缺一不可。 */
export function setHtml(el, html) {
  el.replaceChildren(...new DOMParser().parseFromString(html, 'text/html').body.childNodes);
}

/* SVG 版：以 XML 解析，保证元素落在 SVG 命名空间（生成标记须自闭合、良构） */
export function setSvg(el, markup) {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  el.replaceChildren(...doc.documentElement.childNodes);
}
