import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as taskLib from 'vsts-task-lib/task';
import * as toolLib from 'vsts-task-tool-lib/tool';

export class JavaFilesExtractor {
    public destinationFolder: string;
    public readonly win: boolean;

    // 7zip
    public xpSevenZipLocation: string;
    public winSevenZipLocation: string = path.join(__dirname, '7zip/7z.exe');

    constructor() {
        this.win = (os.platform() === 'win32');
        taskLib.debug('win: ' + this.win);
    }

    private getSevenZipLocation(): string {
        if (this.win) {
            return this.winSevenZipLocation;
        } else {
            if (typeof this.xpSevenZipLocation === "undefined") {
                this.xpSevenZipLocation = taskLib.which('7z', true);
            }
            return this.xpSevenZipLocation;
        }
    }

    private isTar(file): boolean {
        const name = file.toLowerCase();
        // standard gnu-tar extension formats with recognized auto compression formats
        // https://www.gnu.org/software/tar/manual/html_section/tar_69.html
        return name.endsWith('.tar')      // no compression
            || name.endsWith('.tar.gz')   // gzip
            || name.endsWith('.tgz')      // gzip
            || name.endsWith('.taz')      // gzip
            || name.endsWith('.tar.z')    // compress
            || name.endsWith('.tar.bz2')  // bzip2
            || name.endsWith('.tz2')      // bzip2
            || name.endsWith('.tbz2')     // bzip2
            || name.endsWith('.tbz')      // bzip2
            || name.endsWith('.tar.lz')   // lzip
            || name.endsWith('.tar.lzma') // lzma
            || name.endsWith('.tlz')      // lzma
            || name.endsWith('.tar.lzo')  // lzop
            || name.endsWith('.tar.xz')   // xz
            || name.endsWith('.txz');     // xz
    }

    private sevenZipExtract(file: string, destinationFolder: string) {
        //We have to create our own 7Zip extract function as the vsts-task-tool-lib
        //method uses 7zDec, which only decodes .7z archives
        console.log(taskLib.loc('SevenZipExtractFile', file));
        const sevenZip = taskLib.tool(this.getSevenZipLocation());
        sevenZip.arg('x');
        sevenZip.arg('-o' + destinationFolder);
        sevenZip.arg(file);
        const execResult = sevenZip.execSync();
        if (execResult.code != taskLib.TaskResult.Succeeded) {
            taskLib.debug('execResult: ' + JSON.stringify(execResult));
        }
    }

    private async extractFiles(file: string, fileEnding: string): Promise<void> {
        const stats = taskLib.stats(file);
        if (!stats) {
            throw new Error(taskLib.loc('ExtractNonExistFile', file));
        } else if (stats.isDirectory()) {
            throw new Error(taskLib.loc('ExtractDirFailed', file));
        }

        if (this.win) {
            if ('.tar' === fileEnding) { // a simple tar
                this.sevenZipExtract(file, this.destinationFolder);
            } else if (this.isTar(file)) { // a compressed tar, e.g. 'fullFilePath/test.tar.gz'
                // e.g. 'fullFilePath/test.tar.gz' --> 'test.tar.gz'
                const shortFileName = path.basename(file);
                // e.g. 'destinationFolder/_test.tar.gz_'
                const tempFolder = path.normalize(this.destinationFolder + path.sep + '_' + shortFileName + '_');
                console.log(taskLib.loc('CreateTempDir', tempFolder, file));

                // 0 create temp folder
                taskLib.mkdirP(tempFolder);

                // 1 extract compressed tar
                this.sevenZipExtract(file, tempFolder);

                console.log(taskLib.loc('TempDir', tempFolder));
                const tempTar = tempFolder + path.sep + taskLib.ls('-A', [tempFolder])[0]; // should be only one
                console.log(taskLib.loc('DecompressedTempTar', file, tempTar));
                    
                // 2 expand extracted tar
                this.sevenZipExtract(tempTar, this.destinationFolder);

                // 3 cleanup temp folder
                console.log(taskLib.loc('RemoveTempDir', tempFolder));
                taskLib.rmRF(tempFolder);
            } else { // use sevenZip
                this.sevenZipExtract(file, this.destinationFolder);
            }
        } else { // not windows
            if ('.tar' === fileEnding || '.tar.gz' === fileEnding) {
                await toolLib.extractTar(file, this.destinationFolder);
            } else if ('.zip' === fileEnding) {
                await toolLib.extractZip(file, this.destinationFolder);
            } else { // fall through and use sevenZip
                this.sevenZipExtract(file, this.destinationFolder);
            }
        }
    }

    // This method recursively finds all .pack files under fsPath and unpacks them with the unpack200 tool
    private unpackJars(fsPath: string, javaBinPath: string) {
        if (fs.existsSync(fsPath)) {
            if (fs.lstatSync(fsPath).isDirectory()) {
                let self = this;
                fs.readdirSync(fsPath).forEach(function(file,index){
                    const curPath = path.join(fsPath, file);
                    self.unpackJars(curPath, javaBinPath);
                });
            } else if (path.extname(fsPath).toLowerCase() === '.pack') {
                // Unpack the pack file synchonously
                const p = path.parse(fsPath);
                const toolName = process.platform.match(/^win/i) ? 'unpack200.exe' : 'unpack200'; 
                const args = process.platform.match(/^win/i) ? '-r -v -l ""' : '';            
                const name = path.join(p.dir, p.name);
                taskLib.execSync(path.join(javaBinPath, toolName), `${args} "${name}.pack" "${name}.jar"`); 
            }
        }    
    }

    public async unzipJavaDownload(repoRoot: string, fileEnding: string, extractLocation: string): Promise<string> {
        this.destinationFolder = extractLocation;
        let initialDirectoriesList: string[];
        let finalDirectoriesList: string[];
        let jdkDirectory: string;

        // Create the destination folder if it doesn't exist
        if (!taskLib.exist(this.destinationFolder)) {
            console.log(taskLib.loc('CreateDestDir', this.destinationFolder));
            taskLib.mkdirP(this.destinationFolder);
        }

        initialDirectoriesList = taskLib.find(this.destinationFolder).filter(x => taskLib.stats(x).isDirectory());

        const jdkFile = path.normalize(repoRoot);
        const stats = taskLib.stats(jdkFile);
        if (stats.isFile()) {
            await this.extractFiles(jdkFile, fileEnding)
            finalDirectoriesList = taskLib.find(this.destinationFolder).filter(x => taskLib.stats(x).isDirectory());
            taskLib.setResult(taskLib.TaskResult.Succeeded, taskLib.loc('SucceedMsg'));
            jdkDirectory = finalDirectoriesList.filter(dir => initialDirectoriesList.indexOf(dir) < 0)[0];
            this.unpackJars(jdkDirectory, path.join(jdkDirectory, 'bin'));
            return jdkDirectory;
        }
    }

}
