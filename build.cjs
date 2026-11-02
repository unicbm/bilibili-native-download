'use strict';
const fs=require('node:fs');
const path=require('node:path');
const esbuild=require('esbuild');
const root=__dirname;
const out=path.join(root,'dist','bilibili-native-download.user.js');
fs.mkdirSync(path.dirname(out),{recursive:true});
esbuild.buildSync({
  entryPoints:[path.join(root,'entry.js')],outfile:out,bundle:true,platform:'browser',format:'iife',
  target:['chrome120'],minify:true,legalComments:'inline',charset:'utf8',
  banner:{js:fs.readFileSync(path.join(root,'userscript.header.txt'),'utf8')},
  footer:{js:'\n/*\nBUNDLED MEDIABUNNY LICENSE — MPL 2.0\n'+fs.readFileSync(path.join(root,'vendor','LICENSE'),'utf8').replace(/\*\//g,'* /')+'\n*/'}
});
console.log(`${out}\n${fs.statSync(out).size} bytes`);
