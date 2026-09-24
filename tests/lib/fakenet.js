/* 用 node -r 预加载：把三家搜索服务和几个假网页拦在本机，别真出网 */
const real = global.fetch;
const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opt) => {
  const u = String(url && url.url ? url.url : url);
  const auth = ((opt && opt.headers) || {});
  if (u.includes('api.tavily.com')) {
    if (auth.Authorization !== 'Bearer tv-good') return R({ detail: 'bad key' }, 401);
    return R({ answer: '今天是星期三。', results: [
      { title: '新闻一', url: 'https://a.example/1', content: '正文摘要\n  带换行和   多空格' },
      { title: '新闻二', url: 'https://a.example/2', content: 'x'.repeat(500) },
    ] });
  }
  if (u.includes('api.search.brave.com')) {
    if (auth['X-Subscription-Token'] !== 'br-good') return R({}, 422);
    return R({ web: { results: [{ title: 'Brave 一', url: 'https://b.example/1', description: 'brave 摘要' }] } });
  }
  if (u.includes('api.bochaai.com')) {
    if (auth.Authorization !== 'Bearer bo-good') return R({}, 403);
    return R({ data: { webPages: { value: [{ name: '博查一', url: 'https://c.example/1', snippet: '短的', summary: '长一点的总结' }] } } });
  }
  if (u.includes('page.example')) {
    return new Response('<html><head><title>  一篇文章  </title></head><body><script>var x=1;alert("别把我读进去")</script><style>p{color:red}</style><h1>标题在这儿</h1><p>第一段&nbsp;正文&amp;符号</p><p>第二段</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (u.includes('pdf.example')) return new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (u.includes('gone.example')) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  return real(url, opt);
};
