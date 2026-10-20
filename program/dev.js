#!/usr/bin/env node
/**
 * 本地开发：先做一次完整构建，再启动带热更新的预览
 * 预览地址 http://127.0.0.1:8080
 */

const { build, ROOT } = require('./build');

async function dev() {
    process.chdir(ROOT);
    await build();

    const RBuild = require('render-build');
    await RBuild.dev('./');
}

dev().catch((err) => {
    console.error('[dev] 启动失败：', err);
    process.exit(1);
});
