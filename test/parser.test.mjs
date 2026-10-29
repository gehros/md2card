/* =========================================================
   md2card 的单元测试 —— 不需要任何依赖，不需要打包器。

   为什么长这样：这个项目刻意不设构建流程，app.js 是一整个 IIFE，
   直接 import 会拿到一个依赖 document 的函数。
   所以这里用「按标记切片」的办法，把里面纯函数的那两段取出来再跑，
   既保住了零构建，又不用为测试把源码拆成模块。

   运行：node test/parser.test.mjs
   ========================================================= */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker);
  if (a < 0 || b < 0 || b < a) {
    throw new Error('app.js 里的标记没找到：' + startMarker + ' —— 重构时记得同步这里');
  }
  return src.slice(a, b);
}

const parserSrc = slice('const ESC = {', '/* ---------------- 3. 测量与分页');
const paginateSrc = slice('const isHeading = (block)', '/* ---------------- 4. 渲染');

const mdToHtml = new Function(parserSrc + '\nreturn mdToHtml;')();
const paginate = new Function('const GAP = 26;\n' + paginateSrc + '\nreturn paginate;')();

let pass = 0;
function eq(name, actual, expected) {
  assert.equal(actual, expected, name + '\n  实际: ' + actual + '\n  期望: ' + expected);
  pass += 1;
}
function ok(name, cond) {
  assert.ok(cond, name);
  pass += 1;
}

/* ---------- 标题 ---------- */
eq('h1', mdToHtml('# 标题'), '<h1>标题</h1>');
eq('h3', mdToHtml('### 三级'), '<h3>三级</h3>');
eq('h6', mdToHtml('###### 六级'), '<h6>六级</h6>');
eq('# 后面没有空格不算标题', mdToHtml('#不是标题'), '<p>#不是标题</p>');
eq('关闭式标题', mdToHtml('## 标题 ##'), '<h2>标题</h2>');

/* ---------- 行内 ---------- */
eq('加粗', mdToHtml('这是**重点**'), '<p>这是<strong>重点</strong></p>');
eq('斜体', mdToHtml('这是*斜体*'), '<p>这是<em>斜体</em></p>');
eq('删除线', mdToHtml('~~删掉~~'), '<p><del>删掉</del></p>');
eq('行内代码', mdToHtml('用 `npm i` 装'), '<p>用 <code>npm i</code> 装</p>');
eq('行内代码里的星号不被误伤', mdToHtml('`a * b * c`'), '<p><code>a * b * c</code></p>');
eq('链接', mdToHtml('[官网](https://a.com)'),
  '<p><a href="https://a.com" rel="noopener noreferrer">官网</a></p>');

/* ---------- 安全 ---------- */
ok('原始 HTML 不会变成标签',
  mdToHtml('<img src=x onerror=alert(1)>').indexOf('<img') === -1);
eq('尖括号被转义', mdToHtml('<b>粗</b>'), '<p>&lt;b&gt;粗&lt;/b&gt;</p>');

/* ---------- 段落 ---------- */
eq('段落内换行保留', mdToHtml('第一行\n第二行'), '<p>第一行<br>第二行</p>');
eq('空行分段', mdToHtml('A\n\nB'), '<p>A</p><p>B</p>');

/* ---------- 列表 ---------- */
eq('无序列表', mdToHtml('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
eq('有序列表', mdToHtml('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
eq('嵌套列表', mdToHtml('- a\n  - b\n- c'),
  '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
eq('列表后的段落', mdToHtml('- a\n\n段落'), '<ul><li>a</li></ul><p>段落</p>');
eq('列表项里的强调', mdToHtml('- **粗**'), '<ul><li><strong>粗</strong></li></ul>');

/* ---------- 引用 ---------- */
eq('引用', mdToHtml('> 一句话'), '<blockquote><p>一句话</p></blockquote>');
eq('引用里的列表', mdToHtml('> - a\n> - b'),
  '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');

/* ---------- 代码块 ---------- */
eq('围栏代码', mdToHtml('```\nx < y\n```'), '<pre><code>x &lt; y</code></pre>');
eq('带语言标记', mdToHtml('```js\nlet a=1\n```'),
  '<pre data-lang="js"><code>let a=1</code></pre>');
eq('代码块里的 markdown 不解析', mdToHtml('```\n# 不是标题\n```'),
  '<pre><code># 不是标题</code></pre>');
eq('波浪线围栏', mdToHtml('~~~\nx\n~~~'), '<pre><code>x</code></pre>');

/* ---------- 分隔线 ---------- */
eq('分隔线', mdToHtml('---'), '<hr>');
eq('三个星号', mdToHtml('***'), '<hr>');

/* ---------- 综合 ---------- */
const mixed = [
  '# 标题', '', '>  引用  \n>  第二行', '', '```js', 'if (a<b) { x("y") }', '```',
  '', '1. 一', '2. 二', '   - 嵌套', '', '---', '', '结尾 **粗体** 和 `代码`'
].join('\n');
ok('综合样例能产出内容', mdToHtml(mixed).length > 100);
ok('除了合法标签外没有裸露的尖括号',
  !/<(?!\/?(h[1-6]|p|ul|ol|li|pre|code|strong|em|del|blockquote|hr|a|br))/i
    .test(mdToHtml(mixed).replace(/<pre[\s\S]*?<\/pre>/g, '')));

/* ---------- 分页 ---------- */
const b = (h) => ({ h, html: '<p>h' + h + '</p>' });
const hd = (h) => ({ h, html: '<h2>h' + h + '</h2>' });

eq('全部放得下 → 1 页', paginate([b(100), b(100)], 500).length, 1);
eq('放不下 → 2 页', paginate([b(300), b(300)], 500).length, 2);
eq('一页装 3 块', paginate([b(100), b(100), b(100)], 500)[0].length, 3);
ok('单块比整页还高 → 独占一页', paginate([b(100), b(900), b(100)], 500).length === 3);
ok('块不会被丢掉',
  paginate([b(10), b(900), b(10), b(400)], 500).reduce((n, p) => n + p.length, 0) === 4);

// 每块 100 + 间距 26：两块 226、三块 352、四块 478
eq('间距计入后只装 3 块', paginate([b(100), b(100), b(100), b(100)], 400)[0].length, 3);

/* ---------- 孤行控制 ---------- */
// 100 + 26 + 100 = 226，再放一个标题 226 + 26 + 60 = 312 < 400，塞得下
eq('标题 + 正文都放得下时留在本页',
  paginate([b(100), hd(60), b(100)], 400).length, 1);
// 标题 + 正文放不下时，整个推到下一页，避免标题孤零零压在页底
eq('标题会跟着正文一起换页',
  paginate([b(100), b(100), hd(60), b(100)], 300).length, 2);
ok('换页后标题不是页尾最后一个',
  (() => {
    const pages = paginate([b(100), b(100), hd(60), b(100)], 300);
    const last = pages[0][pages[0].length - 1];
    return !/^<h/.test(last.html);
  })());

console.log('全部通过，共 ' + pass + ' 条断言');
