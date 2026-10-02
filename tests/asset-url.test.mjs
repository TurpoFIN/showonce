import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAssetUrl} from '../public/asset-url.js';
test('live media uses the local root and preserves its evidence fragment',()=>{
 assert.equal(resolveAssetUrl('/api/media/live-123#t=3.5,12',new URL('http://127.0.0.1:3000/')),'http://127.0.0.1:3000/api/media/live-123#t=3.5,12');
});
test('live media and fixture media respect an authenticated preview path prefix',()=>{
 const base=new URL('https://workshop.example/proxy/3000/');
 assert.equal(resolveAssetUrl('/api/media/live-123#t=0,4',base),'https://workshop.example/proxy/3000/api/media/live-123#t=0,4');
 assert.equal(resolveAssetUrl('/clips/train-positive-01.mp4',base),'https://workshop.example/proxy/3000/clips/train-positive-01.mp4');
});
test('asset resolver does not rewrite other routes, absolute origins, relative files, or absent URLs',()=>{
 const base=new URL('https://workshop.example/proxy/3000/');
 for(const value of ['/api/state','https://other.example/video.mp4','./favicon.svg',null,undefined])assert.equal(resolveAssetUrl(value,base),value);
});
