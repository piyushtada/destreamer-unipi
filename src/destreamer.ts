"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Utils_1 = require("./Utils");
const PuppeteerHelper_1 = require("./PuppeteerHelper");
const Events_1 = require("./Events");
const TokenCache_1 = require("./TokenCache");
const Metadata_1 = require("./Metadata");
const Thumbnail_1 = require("./Thumbnail");
const CommandLineParser_1 = require("./CommandLineParser");
const is_elevated_1 = __importDefault(require("is-elevated"));
const puppeteer_1 = __importDefault(require("puppeteer"));
const colors_1 = __importDefault(require("colors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const url_1 = require("url");
const sanitize_filename_1 = __importDefault(require("sanitize-filename"));
const cli_progress_1 = __importDefault(require("cli-progress"));
const { FFmpegCommand, FFmpegInput, FFmpegOutput } = require('@tedconf/fessonia')();
const tokenCache = new TokenCache_1.TokenCache();
// The cookie lifetime is one hour,
// let's refresh every 3000 seconds.
const REFRESH_TOKEN_INTERVAL = 3000;
async function init() {
    Events_1.setProcessEvents(); // must be first!
    if (await is_elevated_1.default())
        process.exit(3 /* ELEVATED_SHELL */);
    Utils_1.checkRequirements();
    if (CommandLineParser_1.argv.username)
        console.info('Username: %s', CommandLineParser_1.argv.username);
    if (CommandLineParser_1.argv.simulate)
        console.info(colors_1.default.yellow('Simulate mode, there will be no video download.\n'));
    if (CommandLineParser_1.argv.verbose) {
        console.info('Video URLs:');
        console.info(CommandLineParser_1.argv.videoUrls);
    }
}
async function DoInteractiveLogin(url, username) {
    var _a;
    const videoId = (_a = url.split("/").pop()) !== null && _a !== void 0 ? _a : process.exit(7 /* INVALID_VIDEO_ID */);
    console.log('Launching headless Chrome to perform the OpenID Connect dance...');
    
    
       
    //*********************************************  ADDING UNIPI CREDENTIALS
    	let unipi_usr = "";
    	let unipi_psw = "";
	
	
	var fs = require('fs');
	fs.readFile('credentials.txt', 'utf8', function(err, contents) { //reading into the file credentials.txt
    		unipi_usr = contents.split("\n")[0];
    		unipi_psw = contents.split("\n")[1];
	});
	
	
    	if (!username){
    		username = "no_need_to_change@studenti.unipi.it"	
    	}
    //*********************************************
    
    
    const browser = await puppeteer_1.default.launch({
        executablePath: PuppeteerHelper_1.getPuppeteerChromiumPath(),
        headless: false,
        args: ['--disable-dev-shm-usage']
    });
    const page = (await browser.pages())[0];
    console.log('Navigating to login page...');
    await page.goto(url, { waitUntil: 'load' });
    if (username) {
        await page.waitForSelector('input[type="email"]');
        await page.keyboard.type(username);
        await page.click('input[type="submit"]');
        
       
        //********************* HANDLING UNIPI PAGE
        await page.waitForSelector('input[type="text"]');
        await page.type('input[type="text"]', unipi_usr);
        await page.type('input[type="password"]', unipi_psw);
        await page.click('button[type="submit"]');
        
        await page.waitForSelector('input[type="submit"]');
        await page.click('input[type="submit"]');
        //*********************
    }
    else {
        // If a username was not provided we let the user take actions that
        // lead up to the video page.
    }
    await browser.waitForTarget(target => target.url().includes(videoId), { timeout: 150000 });
    console.info('We are logged in.');
    let session = null;
    let tries = 1;
    while (!session) {
        try {
            let sessionInfo;
            session = await page.evaluate(() => {
                return {
                    AccessToken: sessionInfo.AccessToken,
                    ApiGatewayUri: sessionInfo.ApiGatewayUri,
                    ApiGatewayVersion: sessionInfo.ApiGatewayVersion
                };
            });
        }
        catch (error) {
            if (tries > 5)
                process.exit(10 /* NO_SESSION_INFO */);
            session = null;
            tries++;
            await Utils_1.sleep(3000);
        }
    }
    tokenCache.Write(session);
    console.log('Wrote access token to token cache.');
    console.log("At this point Chromium's job is done, shutting it down...\n");
    await browser.close();
    return session;
}
function extractVideoGuid(videoUrls) {
    const videoGuids = [];
    let guid = '';
    for (const url of videoUrls) {
        try {
            const urlObj = new url_1.URL(url);
            guid = urlObj.pathname.split('/').pop();
        }
        catch (e) {
            console.error(`Unrecognized URL format in ${url}: ${e.message}`);
            process.exit(8 /* INVALID_VIDEO_GUID */);
        }
        if (guid)
            videoGuids.push(guid);
    }
    if (CommandLineParser_1.argv.verbose) {
        console.info('Video GUIDs:');
        console.info(videoGuids);
    }
    return videoGuids;
}
async function downloadVideo(videoUrls, outputDirectories, session) {
    const videoGuids = extractVideoGuid(videoUrls);
    let lastTokenRefresh;
    console.log('Fetching metadata...');
    const metadata = await Metadata_1.getVideoMetadata(videoGuids, session, CommandLineParser_1.argv.verbose);
    if (CommandLineParser_1.argv.simulate) {
        metadata.forEach(video => {
            console.log(colors_1.default.yellow('\n\nTitle: ') + colors_1.default.green(video.title) +
                colors_1.default.yellow('\nPublished Date: ') + colors_1.default.green(video.date) +
                colors_1.default.yellow('\nPlayback URL: ') + colors_1.default.green(video.playbackUrl));
        });
        return;
    }
    if (CommandLineParser_1.argv.verbose)
        console.log(outputDirectories);
    let freshCookie = null;
    const outDirsIdxInc = outputDirectories.length > 1 ? 1 : 0;
    for (let i = 0, j = 0, l = metadata.length; i < l; ++i, j += outDirsIdxInc) {
        const video = metadata[i];
        const pbar = new cli_progress_1.default.SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            format: 'progress [{bar}] {percentage}% {speed} {eta_formatted}',
            // process.stdout.columns may return undefined in some terminals (Cygwin/MSYS)
            barsize: Math.floor((process.stdout.columns || 30) / 3),
            stopOnComplete: true,
            hideCursor: true,
        });
        console.log(colors_1.default.yellow(`\nDownloading Video: ${video.title}\n`));
        video.title = Utils_1.makeUniqueTitle(sanitize_filename_1.default(video.title) + ' - ' + video.date, outputDirectories[j]);
        // Very experimental inline thumbnail rendering
        if (!CommandLineParser_1.argv.noExperiments)
            await Thumbnail_1.drawThumbnail(video.posterImage, session.AccessToken);
        console.info('Spawning ffmpeg with access token and HLS URL. This may take a few seconds...');
        if (!process.stdout.columns) {
            console.info(colors_1.default.red('Unable to get number of columns from terminal.\n' +
                'This happens sometimes in Cygwin/MSYS.\n' +
                'No progress bar can be rendered, however the download process should not be affected.\n\n' +
                'Please use PowerShell or cmd.exe to run destreamer on Windows.'));
        }
        // Try to get a fresh cookie, else gracefully fall back
        // to our session access token (Bearer)
        freshCookie = await tokenCache.RefreshToken(session, freshCookie);
        // Don't remove the "useless" escapes otherwise ffmpeg will
        // not pick up the header
        // eslint-disable-next-line no-useless-escape
        let headers = 'Authorization:\ Bearer\ ' + session.AccessToken;
        if (freshCookie) {
            lastTokenRefresh = Date.now();
            if (CommandLineParser_1.argv.verbose) {
                console.info(colors_1.default.green('Using a fresh cookie.'));
            }
            // eslint-disable-next-line no-useless-escape
            headers = 'Cookie:\ ' + freshCookie;
        }
        const RefreshTokenMaybe = async () => {
            let elapsed = Date.now() - lastTokenRefresh;
            if (elapsed > REFRESH_TOKEN_INTERVAL * 1000) {
                if (CommandLineParser_1.argv.verbose) {
                    console.info(colors_1.default.green('\nRefreshing access token...'));
                }
                lastTokenRefresh = Date.now();
                freshCookie = await tokenCache.RefreshToken(session, freshCookie);
            }
        };
        const outputPath = outputDirectories[j] + path_1.default.sep + video.title + '.' + CommandLineParser_1.argv.format;
        const ffmpegInpt = new FFmpegInput(video.playbackUrl, new Map([
            ['headers', headers]
        ]));
        const ffmpegOutput = new FFmpegOutput(outputPath, new Map([
            CommandLineParser_1.argv.acodec === 'none' ? ['an', null] : ['c:a', CommandLineParser_1.argv.acodec],
            CommandLineParser_1.argv.vcodec === 'none' ? ['vn', null] : ['c:v', CommandLineParser_1.argv.vcodec],
            ['n', null]
        ]));
        const ffmpegCmd = new FFmpegCommand();
        const cleanupFn = () => {
            pbar.stop();
            if (CommandLineParser_1.argv.noCleanup)
                return;
            try {
                fs_1.default.unlinkSync(outputPath);
            }
            catch (e) { }
        };
        pbar.start(video.totalChunks, 0, {
            speed: '0'
        });
        // prepare ffmpeg command line
        ffmpegCmd.addInput(ffmpegInpt);
        ffmpegCmd.addOutput(ffmpegOutput);
        ffmpegCmd.on('update', (data) => {
            const currentChunks = Utils_1.ffmpegTimemarkToChunk(data.out_time);
            RefreshTokenMaybe();
            pbar.update(currentChunks, {
                speed: data.bitrate
            });
            // Graceful fallback in case we can't get columns (Cygwin/MSYS)
            if (!process.stdout.columns) {
                process.stdout.write(`--- Speed: ${data.bitrate}, Cursor: ${data.out_time}\r`);
            }
        });
        process.on('SIGINT', cleanupFn);
        // let the magic begin...
        await new Promise((resolve, reject) => {
            ffmpegCmd.on('error', (error) => {
                if (CommandLineParser_1.argv.skip && error.message.includes('exists') && error.message.includes(outputPath)) {
                    pbar.update(video.totalChunks); // set progress bar to 100%
                    console.log(colors_1.default.yellow(`\nFile already exists, skipping: ${outputPath}`));
                    resolve();
                }
                else {
                    cleanupFn();
                    console.log(`\nffmpeg returned an error: ${error.message}`);
                    process.exit(9 /* UNK_FFMPEG_ERROR */);
                }
            });
            ffmpegCmd.on('success', (data) => {
                pbar.update(video.totalChunks); // set progress bar to 100%
                console.log(colors_1.default.green(`\nDownload finished: ${outputPath}`));
                resolve();
            });
            ffmpegCmd.spawn();
        });
        process.removeListener('SIGINT', cleanupFn);
    }
}
async function main() {
    var _a;
    await init(); // must be first
    const outDirs = Utils_1.getOutputDirectoriesList(CommandLineParser_1.argv.outputDirectory);
    const videoUrls = Utils_1.parseVideoUrls(CommandLineParser_1.argv.videoUrls);
    let session;
    Utils_1.checkOutDirsUrlsMismatch(outDirs, videoUrls);
    Utils_1.makeOutputDirectories(outDirs); // create all dirs now to prevent ffmpeg panic
        
    
    
    session = (_a = tokenCache.Read()) !== null && _a !== void 0 ? _a : await DoInteractiveLogin(videoUrls[0], CommandLineParser_1.argv.username);
    downloadVideo(videoUrls, outDirs, session);
}
main();
//# sourceMappingURL=destreamer.js.map
