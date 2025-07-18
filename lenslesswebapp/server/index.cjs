const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const upload = multer({ dest: '/tmp' }); // Dossier temporaire
const Jimp = require('jimp');


const app = express();
const PORT = 5000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// Helper function to execute a shell command with real-time output
function runCommandLive(command, args, cwd, extractHydraDir = false) {
  console.log(`\n[COMMAND] ${command} ${args.join(' ')}\n`);
  let output = '';
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, shell: true });

    proc.stdout.on('data', (data) => {
      process.stdout.write(`[stdout] ${data}`);
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      process.stderr.write(`[stderr] ${data}`);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        if (extractHydraDir) {
          // Recherche du chemin Hydra uniquement si demandé
          const match = output.match(/Files saved to : (.*)/);
          const hydraOutputDir = match && match[1] ? match[1].trim() : null;
          resolve(hydraOutputDir);
        } else {
          resolve(); // classique : rien à retourner
        }
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

app.post('/run-demo', async (req, res) => {
  try {
    console.log("[SERVER] /run-demo endpoint hit");

    const repoRoot = path.resolve(__dirname)

    const { psfName } = req.body; 
    const baseDir = '/home/pi3/LenslessPiCam-Imane/Psf';
    const userDir = path.join(baseDir, psfName);

    // Create directory if it does not exist
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
;


    // 1. Run on-device capture
    await runCommandLive(
      '/home/pi3/LenslessPiCam/lensless_env/bin/python',
      [
        'scripts/measure/on_device_capture.py',
        'sensor=rpi_hq',
        'bayer=True',
        'fn=capture',
        'exp=0.15',
        'iso=100',
        'config_pause=2',
        'sensor_mode=0',
        'nbits_out=12',
        'legacy=True',
        'rgb=False',
        'gray=False',
        'sixteen=True',
        'auto_exp_psf=true'
      ],
      '/home/pi3/LenslessPiCam-Imane'
    );

    await runCommandLive('mv', [
      'capture.png',
      `Psf/${psfName}/raw_data.png`
    ], '/home/pi3/LenslessPiCam-Imane');
    console.log("File moved");

    // 2. Run color correction & autocorrelation
    await runCommandLive(
      '/home/pi3/LenslessPiCam/lensless_env/bin/python',
      [
        'scripts/measure/analyze_image.py',
        '--fp', `../LenslessPiCam-Imane/Psf/${psfName}/raw_data.png`,
        '--bayer',
        '--gamma', '2.2',
        '--rg', '2.0',
        '--bg', '1.2',
        '--lensless',
        '--down', '2',
        '--save', `Psf/${psfName}/psf_rgb.png`,
        '--save_auto'
      ],
      '/home/pi3/LenslessPiCam-Imane'
    );


    // 5. Read images and respond
    console.log('PSF PATH:', path.resolve(__dirname, '../../Psf', psfName, 'psf_rgb.png'));
    const psfBuffer = fs.readFileSync(path.resolve(__dirname, '../../Psf', psfName, 'psf_rgb_8bit.png'));
    const autocorrBuffer = fs.readFileSync(path.resolve(__dirname, '../../Psf', psfName, 'autocorrelation.png'));
    res.json({
      psf: psfBuffer.toString('base64'),
      autocorr: autocorrBuffer.toString('base64')
    });

  } catch (err) {
    console.error("[SERVER] Error in /run-demo", err);
    res.status(500).send({ error: 'Demo failed to run', details: err.toString() });
  }
});

  app.post('/run-full-imaging', upload.single('image'), async (req, res) => {
    try {
      const psfChosen = req.body.psfChosen;
      const iterations = parseInt(req.body.iterations || '10', 10);
      const algorithm = req.body.algorithm || "ADMM";
      const useAutoExposure = req.body.useAutoExposure === 'true';
      const manualExposure = parseFloat(req.body.manualExposure || '0.04');
      const imagePath = req.file.path;

      console.log(`[DEBUG] useAutoExposure: ${useAutoExposure}, manualExposure: ${manualExposure}s`);


      // 1. Nom de dossier basé sur timestamp (très simple et lisible)
      const captureId = req.body.captureName || Date.now().toString();
      const captureDir = `/home/pi3/LenslessPiCam-Imane/Captures/${captureId}`;
      console.log(`[1] Création du dossier de capture : ${captureDir}`);

      // 2. Crée le dossier de la capture
      if (!fs.existsSync(captureDir)) {
        fs.mkdirSync(captureDir, { recursive: true });
        console.log(`[1] Dossier créé : ${captureDir}`);
      } else {
        console.log(`[1] Dossier déjà existant : ${captureDir}`);
      }

      // 3. Copie l'image uploadée/taken dans ce dossier
      console.log(`[2] Copie de l'image uploadée (${imagePath}) dans ${captureDir}/uploaded.png`);
      await runCommandLive('cp', [
        imagePath,
        `${captureDir}/uploaded.png`
      ], '/home/pi3/LenslessPiCam-Imane');
      console.log(`[2] Copie terminée.`);

      // 4. Affiche l'image sur l'écran distant
      console.log(`[3] Affichage de l'image sur l'écran distant (remote_display.py)`);
      await runCommandLive(
        '/home/pi3/LenslessPiCam/lensless_env/bin/python',
        [
          'scripts/measure/remote_display.py',
          'rpi.username=pi3',
          'rpi.hostname=128.179.187.191',
          `fp=${captureDir}/uploaded.png`,
          "'display.image_res=[900,900]'",
          "'display.vshift=-25'"
        ],
        '/home/pi3/LenslessPiCam-Imane'
      );
      console.log(`[3] Image affichée.`);

      // 5. Capture la photo via la caméra du Pi
      console.log(`[4] Capture via la caméra du Pi (on_device_capture.py)`);
      const baseArgs = [
        'scripts/measure/on_device_capture.py',
        'sensor=rpi_hq',
        'bayer=True',
        'fn=capture',
        ...(useAutoExposure ? ['exp=0.04', 'auto_exp_img=true'] : [`exp=${manualExposure}`]),
        'iso=100',
        'config_pause=2',
        'sensor_mode=0',
        'nbits_out=12',
        'legacy=True',
        'rgb=False',
        'gray=False',
        'sixteen=True'
      ];

      if (useAutoExposure) {
        baseArgs.push('auto_exp_img=true');} // ← très important

      await runCommandLive(
        '/home/pi3/LenslessPiCam/lensless_env/bin/python',
        baseArgs,
        '/home/pi3/LenslessPiCam-Imane'
      );
      console.log(`[4] Capture terminée.`);

      // 6. Déplace la capture (raw) dans le dossier
      console.log(`[5] Déplacement de la capture (raw_data.png)`);
      await runCommandLive('mv', [
        'capture.png',
        `${captureDir}/raw_data.png`
      ], '/home/pi3/LenslessPiCam-Imane');
      console.log(`[5] Déplacement terminé.`);

      // 7. Color-correct
      const colorCorrectedPath = `${captureDir}/data_rgb.png`;
      console.log(`[6] Correction couleur (analyze_image.py)`);
      await runCommandLive(
        '/home/pi3/LenslessPiCam/lensless_env/bin/python',
        [
          'scripts/measure/analyze_image.py',
          '--fp', `${captureDir}/raw_data.png`,
          '--bayer',
          '--gamma', '2.2',
          '--rg', '2.0',
          '--bg', '1.2',
          '--save', colorCorrectedPath
        ],
        '/home/pi3/LenslessPiCam-Imane'
      );
      console.log(`[6] Correction couleur terminée.`);

      // 8. Reconstruction ADMM
      const reconPath = `${captureDir}/reconstruction.png`;
      const psfPath = `/home/pi3/LenslessPiCam-Imane/Psf/${psfChosen}/psf_rgb.png`;
      console.log(`[7] Reconstruction ADMM avec PSF : ${psfPath}`);
      let reconScript, reconArgs;
      if (algorithm === "Gradient Descent") {
        reconScript = 'scripts/recon/gradient_descent.py';
        reconArgs = [
          `input.data=${colorCorrectedPath}`,
          `input.psf=${psfPath}`,
          `gradient_descent.n_iter=${iterations}`
        ];
      } else {
        reconScript = 'scripts/recon/admm.py';
        reconArgs = [
          `input.data=${colorCorrectedPath}`,
          `input.psf=${psfPath}`,
          `admm.n_iter=${iterations}`,
          `preprocess.downsample=2`,
          `display.plot=true`
        ];
      }

      const hydraOutputDir = await runCommandLive(
        '/home/pi3/LenslessPiCam/lensless_env/bin/python',
        [reconScript, ...reconArgs],
        '/home/pi3/LenslessPiCam-Imane',
        true
      );

      console.log(`[7] Reconstruction ADMM terminée.`);
      if (hydraOutputDir) {
        const reconSrc = path.join(hydraOutputDir, `${iterations}.png`);
        await runCommandLive('mv', [reconSrc, reconPath], '/home/pi3/LenslessPiCam-Imane');

        // 🧠 Smart cropping logic starts here
        const Jimp = require('jimp');
        const image = await Jimp.read(reconPath);

        // Step 1: Remove white matplotlib border
        const whiteMargin = 100;
        if (image.bitmap.width > 2 * whiteMargin && image.bitmap.height > 2 * whiteMargin) {
          image.crop(
            whiteMargin,
            whiteMargin,
            image.bitmap.width - 2 * whiteMargin,
            image.bitmap.height - 2 * whiteMargin
          );
        } else {
          console.warn(`⚠️ Skipping white border crop — image too small (${image.bitmap.width}x${image.bitmap.height})`);
        }

        // Step 2: Histogram-based black crop
        const w = image.bitmap.width;
        const h = image.bitmap.height;
        const brightnessThreshold = 30;
        const pixelThreshold = 1;

        let top = 0, bottom = h - 1;
        let left = 0, right = w - 1;

        for (let y = 0; y < h; y++) {
          let count = 0;
          for (let x = 0; x < w; x++) {
            const idx = image.getPixelIndex(x, y);
            const r = image.bitmap.data[idx + 0];
            const g = image.bitmap.data[idx + 1];
            const b = image.bitmap.data[idx + 2];
            const brightness = (r + g + b) / 3;
            if (brightness > brightnessThreshold) count++;
          }
          if (count > pixelThreshold) {
            top = y;
            break;
          }
        }

        for (let y = h - 1; y >= 0; y--) {
          let count = 0;
          for (let x = 0; x < w; x++) {
            const idx = image.getPixelIndex(x, y);
            const r = image.bitmap.data[idx + 0];
            const g = image.bitmap.data[idx + 1];
            const b = image.bitmap.data[idx + 2];
            const brightness = (r + g + b) / 3;
            if (brightness > brightnessThreshold) count++;
          }
          if (count > pixelThreshold) {
            bottom = y;
            break;
          }
        }

        for (let x = 0; x < w; x++) {
          let count = 0;
          for (let y = 0; y < h; y++) {
            const idx = image.getPixelIndex(x, y);
            const r = image.bitmap.data[idx + 0];
            const g = image.bitmap.data[idx + 1];
            const b = image.bitmap.data[idx + 2];
            const brightness = (r + g + b) / 3;
            if (brightness > brightnessThreshold) count++;
          }
          if (count > pixelThreshold) {
            left = x;
            break;
          }
        }

        for (let x = w - 1; x >= 0; x--) {
          let count = 0;
          for (let y = 0; y < h; y++) {
            const idx = image.getPixelIndex(x, y);
            const r = image.bitmap.data[idx + 0];
            const g = image.bitmap.data[idx + 1];
            const b = image.bitmap.data[idx + 2];
            const brightness = (r + g + b) / 3;
            if (brightness > brightnessThreshold) count++;
          }
          if (count > pixelThreshold) {
            right = x;
            break;
          }
        }

        const cropWidth = right - left + 1;
        const cropHeight = bottom - top + 1;

        if (cropWidth > 0 && cropHeight > 0) {
          image.crop(left, top, cropWidth, cropHeight);
          await image.writeAsync(reconPath);
          console.log(`✅ Smart-cropped to: ${cropWidth}x${cropHeight}`);
        } else {
          console.warn(`⚠️ Skipping: invalid crop area.`);
        }

      } else {
        throw new Error('No Hydra output directory detected!');
      }
      // 9. Lis les images pour le frontend
      console.log(`[8] Lecture des images pour le frontend`);
      const imgCapture = fs.readFileSync(path.join(captureDir, 'data_rgb_8bit.png'));
      const imgRecon = fs.readFileSync(reconPath);
      console.log(`[8] Envoi des résultats au frontend 🎉`);

      res.json({
        imgCapture: imgCapture.toString('base64'),
        imgRecon: imgRecon.toString('base64'),
        captureId: captureId 
      });

    } catch (err) {
      console.error("[SERVER] Error in /run-full-imaging", err);
      res.status(500).send({ error: 'Imaging workflow failed', details: err.toString() });
    }
  });

  app.post('/upload-photo', upload.single('photo'), async (req, res) => {
    try {
      const photoPath = path.join('/home/pi3/LenslessPiCam-Imane/PhoneUploads', 'latest.jpg');
      await runCommandLive('mv', [req.file.path, photoPath], '.');
      console.log(`[BACKEND] Received and stored photo at: ${photoPath}`);
      res.send({ status: 'ok' });
    } catch (err) {
      console.error('[SERVER] Error in /upload-photo:', err);
      res.status(500).send({ error: 'Failed to upload photo' });
    }
  });

  app.get('/latest-photo', (req, res) => {
    const filePath = '/home/pi3/LenslessPiCam-Imane/PhoneUploads/latest.jpg';
    if (!fs.existsSync(filePath)) {
      return res.status(404).send("No photo uploaded yet.");
    }
    res.sendFile(filePath);
  });


  app.post('/rerun-reconstruction', async (req, res) => {
    const { captureId, psfName, iterations, algorithm = "ADMM" } = req.body;

    if (!captureId || !psfName || !iterations) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const captureDir = path.join('/home/pi3/LenslessPiCam-Imane/Captures', captureId);
    const psfPath = path.join('/home/pi3/LenslessPiCam-Imane/Psf', psfName, 'psf_rgb.png');
    const colorCorrectedPath = path.join(captureDir, 'data_rgb.png');
    const reconPath = path.join(captureDir, 'reconstruction.png');

    try {
      if (!fs.existsSync(colorCorrectedPath) || !fs.existsSync(psfPath)) {
        return res.status(404).json({ error: "Required files not found" });
      }

      let reconScript, reconArgs;
      if (algorithm === "Gradient Descent") {
        reconScript = 'scripts/recon/gradient_descent.py';
        reconArgs = [
          `input.data=${colorCorrectedPath}`,
          `input.psf=${psfPath}`,
          `gradient_descent.n_iter=${iterations}`
        ];
      } else {
        reconScript = 'scripts/recon/admm.py';
        reconArgs = [
          `input.data=${colorCorrectedPath}`,
          `input.psf=${psfPath}`,
          `admm.n_iter=${iterations}`,
          `preprocess.downsample=2`,
          `display.plot=true`
        ];
      }

      const hydraOutputDir = await runCommandLive(
        '/home/pi3/LenslessPiCam/lensless_env/bin/python',
        [reconScript, ...reconArgs],
        '/home/pi3/LenslessPiCam-Imane',
        true
      );
      


      if (!hydraOutputDir) {
        return res.status(500).json({ error: "No Hydra output directory found" });
      }

      const newReconPath = path.join(hydraOutputDir, `${iterations}.png`);
      await runCommandLive('mv', [newReconPath, reconPath], '/home/pi3/LenslessPiCam-Imane');
      
      // 🧠 Smart cropping logic starts here
      const Jimp = require('jimp');
      const image = await Jimp.read(reconPath);

      // Step 1: Remove white matplotlib border
      const whiteMargin = 100;
      if (image.bitmap.width > 2 * whiteMargin && image.bitmap.height > 2 * whiteMargin) {
        image.crop(
          whiteMargin,
          whiteMargin,
          image.bitmap.width - 2 * whiteMargin,
          image.bitmap.height - 2 * whiteMargin
        );
      } else {
        console.warn(`⚠️ Skipping white border crop — image too small (${image.bitmap.width}x${image.bitmap.height})`);
      }

      // Step 2: Histogram-based black crop
      const w = image.bitmap.width;
      const h = image.bitmap.height;
      const brightnessThreshold = 25;
      const pixelThreshold = 1;

      let top = 0, bottom = h - 1;
      let left = 0, right = w - 1;

      for (let y = 0; y < h; y++) {
        let count = 0;
        for (let x = 0; x < w; x++) {
          const idx = image.getPixelIndex(x, y);
          const r = image.bitmap.data[idx + 0];
          const g = image.bitmap.data[idx + 1];
          const b = image.bitmap.data[idx + 2];
          const brightness = (r + g + b) / 3;
          if (brightness > brightnessThreshold) count++;
        }
        if (count > pixelThreshold) {
          top = y;
          break;
        }
      }

      for (let y = h - 1; y >= 0; y--) {
        let count = 0;
        for (let x = 0; x < w; x++) {
          const idx = image.getPixelIndex(x, y);
          const r = image.bitmap.data[idx + 0];
          const g = image.bitmap.data[idx + 1];
          const b = image.bitmap.data[idx + 2];
          const brightness = (r + g + b) / 3;
          if (brightness > brightnessThreshold) count++;
        }
        if (count > pixelThreshold) {
          bottom = y;
          break;
        }
      }

      for (let x = 0; x < w; x++) {
        let count = 0;
        for (let y = 0; y < h; y++) {
          const idx = image.getPixelIndex(x, y);
          const r = image.bitmap.data[idx + 0];
          const g = image.bitmap.data[idx + 1];
          const b = image.bitmap.data[idx + 2];
          const brightness = (r + g + b) / 3;
          if (brightness > brightnessThreshold) count++;
        }
        if (count > pixelThreshold) {
          left = x;
          break;
        }
      }

      for (let x = w - 1; x >= 0; x--) {
        let count = 0;
        for (let y = 0; y < h; y++) {
          const idx = image.getPixelIndex(x, y);
          const r = image.bitmap.data[idx + 0];
          const g = image.bitmap.data[idx + 1];
          const b = image.bitmap.data[idx + 2];
          const brightness = (r + g + b) / 3;
          if (brightness > brightnessThreshold) count++;
        }
        if (count > pixelThreshold) {
          right = x;
          break;
        }
      }

      const cropWidth = right - left + 1;
      const cropHeight = bottom - top + 1;

      if (cropWidth > 0 && cropHeight > 0) {
        image.crop(left, top, cropWidth, cropHeight);
        await image.writeAsync(reconPath);
        console.log(`✅ Smart-cropped to: ${cropWidth}x${cropHeight}`);
      } else {
        console.warn(`⚠️ Skipping: invalid crop area.`);
      }



      const reconBuffer = fs.readFileSync(reconPath);
      res.json({ recon: reconBuffer.toString('base64') });

    } catch (err) {
      console.error("[SERVER] Error in /rerun-reconstruction", err);
      res.status(500).send({ error: "Reconstruction failed", details: err.toString() });
    }
  });


  // Endpoint to list available PSFs (directories inside /Psf)
  app.get('/list-psfs', (req, res) => {
    const baseDir = '/home/pi3/LenslessPiCam-Imane/Psf';
    fs.readdir(baseDir, { withFileTypes: true }, (err, files) => {
      if (err) {
        console.error("[SERVER] Error listing PSFs:", err);
        return res.status(500).json({ error: 'Could not read PSF directory' });
      }
      // Filter for directories only
      const psfList = files.filter(f => f.isDirectory()).map(f => f.name);
      res.json({ psfs: psfList });
    });
  });

  app.get('/load-psf/:psfname', (req, res) => {
    const psfName = req.params.psfname;
    const psfDir = path.join('/home/pi3/LenslessPiCam-Imane/Psf', psfName);

    const psfPath = path.join(psfDir, 'psf_rgb.png');
    const autocorrPath = path.join(psfDir, 'autocorrelation.png');

    if (!fs.existsSync(psfPath) || !fs.existsSync(autocorrPath)) {
      return res.status(404).json({ error: 'PSF or autocorrelation image not found' });
    }

    const psfBuffer = fs.readFileSync(path.join(psfDir, 'psf_rgb_8bit.png'));
    const autocorrBuffer = fs.readFileSync(autocorrPath);

    res.json({
      psf: psfBuffer.toString('base64'),
      autocorr: autocorrBuffer.toString('base64'),
    });
  });

  app.get('/list-captures', (req, res) => {
    const baseDir = '/home/pi3/LenslessPiCam-Imane/Captures';
    fs.readdir(baseDir, { withFileTypes: true }, (err, files) => {
      if (err) {
        console.error("[SERVER] Error listing captures:", err);
        return res.status(500).json({ error: 'Could not read Captures directory' });
      }
      const captureList = files.filter(f => f.isDirectory()).map(f => f.name);
      res.json({ captures: captureList });
    });
  })

  app.get('/load-capture/:captureId', (req, res) => {
    const { captureId } = req.params;
    const captureDir = path.join('/home/pi3/LenslessPiCam-Imane/Captures', captureId);
    let psfName = 'PSF_1mm'; // ⬅️ fallback default

    const rawPath = path.join(captureDir, 'data_rgb_8bit.png');
    const reconPath = path.join(captureDir, 'reconstruction.png');
    const uploadedPath = path.join(captureDir, 'uploaded.png');

    if (!fs.existsSync(rawPath) || !fs.existsSync(reconPath)) {
      return res.status(404).json({ error: 'Files not found in capture folder' });
    }

    const imgCapture = fs.readFileSync(rawPath);
    const imgRecon = fs.readFileSync(reconPath);
    let imgUpload = null;
    if (fs.existsSync(uploadedPath)) {
      imgUpload = fs.readFileSync(uploadedPath);
    }
    res.json({
      imgCapture: imgCapture.toString('base64'),
      imgRecon: imgRecon.toString('base64'),
      imgUpload: imgUpload ? imgUpload.toString('base64') : null,psfName

    });
  });



  const archiver = require('archiver'); // ← if not yet added at the top

  app.get('/download-psf-zip/:psfname', (req, res) => {
    const psfName = req.params.psfname;
    console.log(`[BACKEND] Requested PSF ZIP: ${psfName}`);
    const psfDir = path.join('/home/pi3/LenslessPiCam-Imane/Psf', psfName);

    if (!fs.existsSync(psfDir)) {
      return res.status(404).send('PSF not found');
    }

    const zipName = `${psfName}_psf.zip`;
    res.setHeader('Content-Disposition', `attachment; filename=${zipName}`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    ['psf_rgb_8bit.png', 'autocorrelation.png'].forEach(file => {
      const fullPath = path.join(psfDir, file);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, { name: file });
      }
    });

    archive.finalize();
  });

  app.get('/download-capture-zip/:captureId', (req, res) => {
  const captureId = req.params.captureId;
  const captureDir = path.join('/home/pi3/LenslessPiCam-Imane/Captures', captureId);

  if (!fs.existsSync(captureDir)) {
    return res.status(404).send("Capture folder not found.");
  }

  const zipName = `capture_${captureId}.zip`;
  res.setHeader('Content-Disposition', `attachment; filename=${zipName}`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  ['data_rgb_8bit.png', 'reconstruction.png'].forEach(file => {
    const filePath = path.join(captureDir, file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file });
    }
  });

  archive.finalize();
});



// HTTPS server
const key = fs.readFileSync(path.join(__dirname, '../certs/key.pem'));
const cert = fs.readFileSync(path.join(__dirname, '../certs/cert.pem'));

https.createServer({ key, cert }, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Demo backend running on https://128.179.187.191:${PORT}`);
});