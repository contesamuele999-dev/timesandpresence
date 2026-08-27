import { copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const androidDir = join(root, 'android');
const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
const userProfile = process.env.USERPROFILE || '';
const candidates = [
  process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', javaName),
  userProfile && join(userProfile, 'Documents', 'Android-Sdk', 'jdk-21', 'bin', javaName),
  process.platform === 'win32' && 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe',
].filter(Boolean);

let java;
for(const candidate of candidates){
  if(!existsSync(candidate)) continue;
  const check = spawnSync(candidate, ['-version'], {encoding:'utf8'});
  const versionText = `${check.stdout || ''}${check.stderr || ''}`;
  const match = versionText.match(/version "(\d+)/);
  const major = match ? Number(match[1]) : 0;
  if(major >= 17 && major <= 24){ java = candidate; break; }
}

if(!java){
  throw new Error('Serve un JDK dalla versione 17 alla 24 (consigliato JDK 21) per compilare Presencer.');
}

const javaArgs = [];
const avastTrustStore = userProfile && join(userProfile, 'Documents', 'Android-Sdk', 'cacerts-con-avast');
if(avastTrustStore && existsSync(avastTrustStore)){
  javaArgs.push(`-Djavax.net.ssl.trustStore=${avastTrustStore}`);
  javaArgs.push('-Djavax.net.ssl.trustStorePassword=changeit');
}
javaArgs.push(
  '-classpath', join(androidDir, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
  'org.gradle.wrapper.GradleWrapperMain',
  '-p', androidDir,
  'assembleDebug',
  '--no-daemon',
);

const env = Object.assign({}, process.env, {
  GRADLE_USER_HOME:join(root, '.gradle-local'),
});
if(!env.ANDROID_HOME && userProfile){
  const standardSdk = join(userProfile, 'AppData', 'Local', 'Android', 'Sdk');
  if(existsSync(standardSdk)) env.ANDROID_HOME = standardSdk;
}

const result = spawnSync(java, javaArgs, {cwd:root, env, stdio:'inherit'});
if(result.status !== 0) process.exit(result.status || 1);

const source = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const destination = join(root, 'Presencer-debug.apk');
await copyFile(source, destination);
const info = await stat(destination);
console.log(`APK creato: ${destination} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);

