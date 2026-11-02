import { Input, MP4, CustomSource, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Output, Mp4OutputFormat, StreamTarget } from 'mediabunny';
import { createBiliCore } from './core.js';
import { createBiliNetwork } from './network.js';
import { createRangeEngine } from './range-engine.js';
import { createMediaEngine } from './engine.js';
import { startBiliDownloader } from './main.js';
import { createSaveFilePicker } from './picker.js';

const core=createBiliCore();
const network=createBiliNetwork({core,gmRequest:GM_xmlhttpRequest,nativeFetch:window.fetch.bind(window)});
const range=createRangeEngine({request:network.requestRange});
const media=createMediaEngine({Input,MP4,CustomSource,EncodedPacketSink,EncodedVideoPacketSource,EncodedAudioPacketSource,Output,Mp4OutputFormat,StreamTarget});
const pickerWindow=typeof unsafeWindow!=='undefined'?unsafeWindow:document.defaultView;
const pickSaveFile=createSaveFilePicker(pickerWindow);
startBiliDownloader({win:window,doc:document,network,range,media,core,pickSaveFile,getValue:GM_getValue,setValue:GM_setValue,menu:GM_registerMenuCommand});
