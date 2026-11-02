// This build has its own identity and no official update feed.
module.exports = {
  extends: './electron-builder.yml',
  appId: 'com.hadriencornier.LearnHarness',
  productName: 'Hadrien LearnHarness',
  artifactName: 'Hadrien-LearnHarness-${version}-${arch}.${ext}',
  directories: { output: 'dist-custom' },
  extraMetadata: {
    name: 'hadrien-learnharness',
    customBuild: true,
    homepage: 'https://github.com/Hadrien-Cornier/learnharness',
  },
  mac: {
    icon: 'build/icon.icns',
    identity: null,
    notarize: false,
    hardenedRuntime: false,
    target: [{ target: 'zip', arch: ['arm64'] }, { target: 'dmg', arch: ['arm64'] }],
  },
  publish: null,
};
