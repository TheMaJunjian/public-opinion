import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {migrateViewFile} from './migrate-view-file.js';
const [input,output]=process.argv.slice(2);
if(!input||!output||resolve(input)===resolve(output))throw new Error('请提供不同的输入和输出文件：db:migrate-view INPUT OUTPUT');
const result=migrateViewFile(JSON.parse(await readFile(input,'utf8')));
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(`阅览文件迁移完成：${result.messages.length} 条消息，原文件已保留。`);
