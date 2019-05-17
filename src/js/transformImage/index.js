import { isImage } from './utils/isImage';
import { imageToImageData } from './utils/imageToImageData';
import { imageDataToBlob } from './utils/imageDataToBlob';
import { cropSVG } from './utils/cropSVG';
import { objectToImageData } from './utils/objectToImageData';
import { TransformWorker } from './utils/TransformWorker';
import { getImageHead } from './utils/getImageHead';
import { createBlob } from './utils/createBlob';
import { createWorker } from './utils/createWorker';
import { loadImage } from './utils/loadImage';

export const transformImage = (blob, instructions, options = {}) => new Promise((resolve, reject) => {

    // if the file is not an image we do not have any business transforming it
    if (!blob || !isImage(blob)) return reject();

    // get separate options for easier use
    const { stripImageHead, beforeCreateBlob, afterCreateBlob } = options;

    // get crop
    const { crop, size, filter, output } = instructions;

    // get exif orientation
    const orientation = instructions.image && instructions.image.orientation ? Math.max(1, Math.min(8, instructions.image.orientation)) : null;

    // compression quality 0 => 100
    const qualityAsPercentage = output && output.quality;
    const quality = qualityAsPercentage === null ? null : qualityAsPercentage / 100;

    // output format
    const type = output && output.type || null;

    // get transforms
    const transforms = [];

    // add resize transforms if set
    if (size && (typeof size.width === 'number' || typeof size.height === 'number')) {
        transforms.push({ type:'resize', data: size });
    }

    // add filters
    if (filter && filter.length === 20) {
        transforms.push({ type: 'filter', data: filter });
    }

    // resolves with supplied blob
    const resolveWithBlob = blob => {
        const promisedBlob = afterCreateBlob ? afterCreateBlob(blob) : blob;
        Promise.resolve(promisedBlob).then(resolve);
    }

    // done
    const toBlob = (imageData, options) => 
        imageDataToBlob(imageData, options, beforeCreateBlob)
        .then(blob => {

            // remove image head (default)
            if (stripImageHead) return resolveWithBlob(blob);

            // try to copy image head
            getImageHead(blob).then(imageHead => {

                // re-inject image head EXIF info in case of JPEG, as the image head is removed by canvas export
                if (imageHead !== null) {
                    blob = new Blob([imageHead, blob.slice(20)], { type: blob.type });
                }
                
                // done!
                resolveWithBlob(blob);
            });
        })
        .catch(reject);

    // if this is an svg and we want it to stay an svg
    if (/svg/.test(blob.type) && type === null) {
        return cropSVG(blob, crop).then(text => {
            resolve(
                createBlob(text, 'image/svg+xml')
            );
        });
    }

    // get file url
    const url = URL.createObjectURL(blob);

    // turn the file into an image
    loadImage(url).then(image => {

        // url is no longer needed
        URL.revokeObjectURL(url);

        // draw to canvas and start transform chain
        const imageData = imageToImageData(image, orientation, crop);

        // determine the format of the blob that we will output
        const outputFormat = {
            quality,
            type: type || blob.type
        };

        // no transforms necessary, we done!
        if (!transforms.length) {
            return toBlob(imageData, outputFormat);
        }

        // send to the transform worker to transform the blob on a separate thread
        const worker = createWorker(TransformWorker);
        worker.post(
            {
                transforms,
                imageData
            },
            response => {

                // finish up
                toBlob(objectToImageData(response), outputFormat);

                // stop worker
                worker.terminate();
            },
            [imageData.data.buffer]
        );
    });
})