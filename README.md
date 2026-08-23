# LHwiki

LHwiki 是面向潞河校园的轻量共建手册：公开阅读、校内学号投稿、人工审核发布。内容聚焦教师、课程、社团、校园生活与备考经验，强调具体、真诚和可追溯的分享。

- 在线网站：[LHwiki · CloudBase 上海](https://lhwiki-d9g6r8vfzc7be1c0a-1465088461.ap-shanghai.app.tcloudbase.com/)
- 当前版本：**v0.8.6**
- 技术栈：原生 JavaScript、Node.js 20 HTTP 云函数、CloudBase 静态托管、PostgreSQL、RLS
- 源码目录：[`LHwiki-source-20260808/`](LHwiki-source-20260808/)
- 完整版本记录：[`CHANGELOG.md`](CHANGELOG.md)

## 最近更新

- 维护期间重新开放完整编辑器，文字编辑、预览和 Markdown 均只在当前浏览器运行，不访问 PostgreSQL。
- 云端保存与正式提交继续停用；原按钮保留，点击后仅写入本机副本并显示维护提示。
- 自动发现并恢复最近的本机草稿；离开含有修改的编辑页前请求浏览器确认，同时建议另存本机文档或 Markdown。
- 此前已成功保存在云端的版本不作修改，维护恢复后仍可重新下载。

## 本地测试

```powershell
cd LHwiki-source-20260808
pnpm install
pnpm test
```

生产部署说明见 [`cloudbase/README.md`](LHwiki-source-20260808/cloudbase/README.md)。项目采用 MIT License。请勿将生产 API Key、学生学号、未公开投稿、审核记录或 `backup/` 数据上传到公开仓库。
