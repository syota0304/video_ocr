import {useState, type ChangeEvent, useRef, type MouseEvent, useEffect, useCallback} from 'react';
import './App.css';
import Tesseract from 'tesseract.js';

interface SelectionRect {
    x: number;
    y: number;
    width: number;
    height: number;
    threshold: number;
    scaleX: number;
    scaleY: number;
    digitsOnly: boolean;
    label: string;
}

export function App() {
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [capturedImage, setCapturedImage] = useState<ImageData | null>(null);
    const [frameRate, setFrameRate] = useState(60);

    const [isSelectionEnabled, setIsSelectionEnabled] = useState(false);
    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
    const [endPoint, setEndPoint] = useState<{ x: number; y: number } | null>(null);
    const [selections, setSelections] = useState<SelectionRect[]>([]);
    const [ocrResults, setOcrResults] = useState<string[]>([]);
    const [isOcrRunning, setIsOcrRunning] = useState(false);
    const [processedImages, setProcessedImages] = useState<string[]>([]);
    const [redrawIndex, setRedrawIndex] = useState<number | null>(null);

    // State for auto-seeking
    const [isSeeking, setIsSeeking] = useState(false);
    const [referenceIndex, setReferenceIndex] = useState<number | null>(null);
    const [diffThreshold, setDiffThreshold] = useState(10); // Default difference sensitivity
    const referenceImageData = useRef<ImageData | null>(null);


    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            setVideoSrc(url);
            setCapturedImage(null);
            setIsSelectionEnabled(false);
            setSelections([]);
            setOcrResults([]);
            setProcessedImages([]);
            setRedrawIndex(null);
            setIsSeeking(false);
            setReferenceIndex(null);
        }
    };

    const captureFrame = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (video && canvas && !video.paused) video.pause();
        if (video && canvas) {
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (context) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                setCapturedImage(context.getImageData(0, 0, canvas.width, canvas.height));
                setOcrResults([]);
                setProcessedImages([]);
            }
        }
    }, []);

    const getCanvasCoordinates = (event: MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return {x: 0, y: 0};
        const rect = canvas.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    };

    const handleMouseDown = (event: MouseEvent<HTMLCanvasElement>) => {
        if (!isSelectionEnabled || !capturedImage) return;
        event.preventDefault();
        setIsDrawing(true);
        const pos = getCanvasCoordinates(event);
        setStartPoint(pos);
        setEndPoint(pos);
    };

    const handleMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
        if (!isDrawing) return;
        event.preventDefault();
        const pos = getCanvasCoordinates(event);
        setEndPoint(pos);
    };

    const handleMouseUp = (event: MouseEvent<HTMLCanvasElement>) => {
        if (!isDrawing || !startPoint || !endPoint) return;
        event.preventDefault();

        const newCoords = {
            x: Math.min(startPoint.x, endPoint.x),
            y: Math.min(startPoint.y, endPoint.y),
            width: Math.abs(endPoint.x - startPoint.x),
            height: Math.abs(endPoint.y - startPoint.y),
        };

        if (newCoords.width > 2 && newCoords.height > 2) {
            if (redrawIndex !== null) {
                setSelections(prev => prev.map((selection, index) =>
                    index === redrawIndex
                        ? {...selection, ...newCoords}
                        : selection
                ));
                setRedrawIndex(null);
            } else {
                setSelections(prev => [...prev, {
                    ...newCoords,
                    label: `Selection ${prev.length + 1}`,
                    threshold: 128,
                    scaleX: 1,
                    scaleY: 1,
                    digitsOnly: false
                }]);
            }
        }

        setIsDrawing(false);
        setStartPoint(null);
        setEndPoint(null);
    };

    const handleDeleteSelection = (indexToDelete: number) => {
        setSelections(prev => prev.filter((_, index) => index !== indexToDelete));
        setOcrResults(prev => prev.filter((_, index) => index !== indexToDelete));
        setProcessedImages(prev => prev.filter((_, index) => index !== indexToDelete));
    };

    const handleRedraw = (index: number) => {
        setIsSelectionEnabled(true);
        setRedrawIndex(index);
    };

    const handleSelectionParamChange = (indexToChange: number, param: keyof SelectionRect, value: string | number | boolean) => {
        const updatedSelections = selections.map((selection, index) => {
            if (index === indexToChange) {
                return {...selection, [param]: value};
            }
            return selection;
        });
        setSelections(updatedSelections);
    };

    const handleSeek = useCallback((seconds: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime += seconds;
        }
    }, []);

    const runOCR = useCallback(async () => {
        if (processedImages.length === 0 || selections.length !== processedImages.length || isOcrRunning) return;
        setIsOcrRunning(true);
        setOcrResults(Array(selections.length).fill('Processing...'));

        const digitScheduler = Tesseract.createScheduler();
        const normalScheduler = Tesseract.createScheduler();

        try {
            const digitWorker = await Tesseract.createWorker('eng');
            await digitWorker.setParameters({tessedit_char_whitelist: '0123456789'});
            digitScheduler.addWorker(digitWorker);

            const normalWorker = await Tesseract.createWorker('eng');
            normalScheduler.addWorker(normalWorker);

            const jobPromises = selections.map((selection, index) => {
                const imageUrl = processedImages[index];
                const scheduler = selection.digitsOnly ? digitScheduler : normalScheduler;
                return scheduler.addJob('recognize', imageUrl).then((result: any) => ({result, index}));
            });

            const jobResults = await Promise.all(jobPromises);

            const finalResults = Array(selections.length).fill('');
            jobResults.forEach((jobResult: any) => {
                finalResults[jobResult.index] = jobResult.result.data.text;
            });

            setOcrResults(finalResults);

        } catch (error) {
            console.error('OCR Error:', error);
            setOcrResults(Array(selections.length).fill('Error'));
        } finally {
            await digitScheduler.terminate();
            await normalScheduler.terminate();
            setIsOcrRunning(false);
        }
    }, [processedImages, selections, isOcrRunning]);

    // Effect for Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) {
                return;
            }

            if (!videoSrc) return;

            switch (event.key.toLowerCase()) {
                case 'd':
                    handleSeek(-1);
                    break;
                case 'f':
                    handleSeek(-(1 / frameRate));
                    break;
                case 'j':
                    handleSeek(1 / frameRate);
                    break;
                case 'k':
                    handleSeek(1);
                    break;
                case ' ':
                    event.preventDefault();
                    runOCR();
                    break;
                default:
                    break;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [videoSrc, frameRate, handleSeek, runOCR]);

    // Effect to pre-process images for table display
    useEffect(() => {
        if (!capturedImage || !canvasRef.current) return;

        const mainContext = canvasRef.current.getContext('2d');
        if (!mainContext) return;

        const urls = selections.map(rect => {
            const scaledWidth = Math.round(rect.width * rect.scaleX);
            const scaledHeight = Math.round(rect.height * rect.scaleY);

            if (scaledWidth <= 0 || scaledHeight <= 0) return '';

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = scaledWidth;
            tempCanvas.height = scaledHeight;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) return '';

            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = rect.width;
            srcCanvas.height = rect.height;
            const srcCtx = srcCanvas.getContext('2d');
            if (!srcCtx) return '';
            const originalImageData = mainContext.getImageData(rect.x, rect.y, rect.width, rect.height);
            srcCtx.putImageData(originalImageData, 0, 0);

            tempCtx.drawImage(srcCanvas, 0, 0, scaledWidth, scaledHeight);

            const imageData = tempCtx.getImageData(0, 0, scaledWidth, scaledHeight);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
                const color = avg > rect.threshold ? 0 : 255;
                data[i] = color;
                data[i + 1] = color;
                data[i + 2] = color;
            }
            tempCtx.putImageData(imageData, 0, 0);
            return tempCanvas.toDataURL();
        });
        setProcessedImages(urls);

    }, [selections, capturedImage]);

    const compareImageData = (d1: Uint8ClampedArray, d2: Uint8ClampedArray) => {
        let diff = 0;
        for (let i = 0; i < d1.length; i += 4) {
            const gray1 = (d1[i] + d1[i + 1] + d1[i + 2]) / 3;
            const gray2 = (d2[i] + d2[i + 1] + d2[i + 2]) / 3;
            diff += Math.abs(gray1 - gray2);
        }
        return diff / (d1.length / 4);
    };

    const findNextChange = useCallback(async () => {
        if (referenceIndex === null || !videoRef.current || !canvasRef.current) return;

        const video = videoRef.current;
        const mainCtx = canvasRef.current.getContext('2d', {willReadFrequently: true});
        if (!mainCtx) return;

        const rect = selections[referenceIndex];
        referenceImageData.current = mainCtx.getImageData(rect.x, rect.y, rect.width, rect.height);

        setIsSeeking(true);

        let seeking = true;
        const stopSeeking = () => {
            seeking = false;
        };
        document.addEventListener('stop-seeking', stopSeeking, {once: true});

        while (seeking && !video.ended) {
            video.currentTime += (1 / frameRate);
            await new Promise(resolve => {
                const onSeeked = () => {
                    video.removeEventListener('seeked', onSeeked);
                    resolve(null);
                };
                video.addEventListener('seeked', onSeeked);
            });

            const newImageData = mainCtx.getImageData(rect.x, rect.y, rect.width, rect.height);
            const diff = compareImageData(referenceImageData.current.data, newImageData.data);

            if (diff > diffThreshold) {
                break;
            }
        }

        document.removeEventListener('stop-seeking', stopSeeking);
        captureFrame();
        setIsSeeking(false);

    }, [referenceIndex, selections, frameRate, diffThreshold, captureFrame]);

    useEffect(() => {
        if (isSeeking) {
            const handleStop = () => setIsSeeking(false);
            // A way to stop the loop externally
            document.addEventListener('stop-seeking', handleStop);
            findNextChange();
            return () => document.removeEventListener('stop-seeking', handleStop);
        }
    }, [isSeeking, findNextChange]);


    // Effect to draw on main canvas
    useEffect(() => {
        if (!capturedImage || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        context.putImageData(capturedImage, 0, 0);
        context.lineWidth = 2;

        selections.forEach((rect, index) => {
            if (index === redrawIndex) context.strokeStyle = 'orange';
            else if (index === referenceIndex) context.strokeStyle = 'green';
            else context.strokeStyle = 'blue';
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);
        });

        if (isDrawing && startPoint && endPoint) {
            context.strokeStyle = 'red';
            context.strokeRect(startPoint.x, startPoint.y, endPoint.x - startPoint.x, endPoint.y - startPoint.y);
        }
    }, [capturedImage, selections, isDrawing, startPoint, endPoint, redrawIndex, referenceIndex]);

    return (
        <div className="App">
            <header className="App-header">
                <h1>Video OCR</h1>
                <input type="file" accept="video/*" onChange={handleFileChange}/>
                {videoSrc && (
                    <div>
                        <video ref={videoRef} controls src={videoSrc} onSeeked={captureFrame}
                               style={{width: '100%', maxWidth: '700px', marginTop: '20px'}}/>
                        <div style={{
                            marginTop: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            flexWrap: 'wrap'
                        }}>
                            <button onClick={() => handleSeek(-1)}>Back 1s (D)</button>
                            <button onClick={() => handleSeek(-(1 / frameRate))}>Back 1f (F)</button>
                            <button onClick={() => handleSeek(1 / frameRate)}>Forward 1f (J)</button>
                            <button onClick={() => handleSeek(1)}>Forward 1s (K)</button>
                            <label style={{marginLeft: '10px'}}>
                                FPS:
                                <input type="number" value={frameRate}
                                       onChange={(e) => setFrameRate(parseInt(e.target.value, 10) || 60)} min={1}
                                       style={{width: '50px', marginLeft: '5px'}}/>
                            </label>
                        </div>
                        <div style={{
                            marginTop: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            flexWrap: 'wrap'
                        }}>
                            <button onClick={captureFrame}>Capture Frame</button>
                            {capturedImage && (
                                <>
                                    <button onClick={() => {
                                        setIsSelectionEnabled(!isSelectionEnabled);
                                        if (isSelectionEnabled) setRedrawIndex(null);
                                    }} style={{marginLeft: '10px'}}>
                                        {isSelectionEnabled ? 'Disable' : 'Enable'} Selection
                                    </button>
                                    <button onClick={runOCR} disabled={isOcrRunning || selections.length === 0}
                                            style={{marginLeft: '10px'}}>
                                        {isOcrRunning ? 'Processing...' : 'Run OCR (Space)'}
                                    </button>
                                </>
                            )}
                            {selections.length > 0 && (
                                <button onClick={() => {
                                    setSelections([]);
                                    setOcrResults([]);
                                    setProcessedImages([]);
                                    setRedrawIndex(null);
                                }} style={{marginLeft: '10px'}}>
                                    Reset Selections
                                </button>
                            )}
                        </div>
                        {selections.length > 0 && (
                            <div style={{
                                marginTop: '10px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                flexWrap: 'wrap'
                            }}>
                                <button onClick={() => setIsSeeking(!isSeeking)} disabled={referenceIndex === null}>
                                    {isSeeking ? 'Stop Seeking' : 'Find Next Change'}
                                </button>
                                <label>
                                    Diff Threshold:
                                    <input type="number" value={diffThreshold}
                                           onChange={(e) => setDiffThreshold(parseInt(e.target.value, 10) || 10)}
                                           min={1} max={255} style={{width: '50px', marginLeft: '5px'}}/>
                                </label>
                            </div>
                        )}
                        {selections.length > 0 && (
                            <div style={{marginTop: '20px'}}>
                                <h3>Selections</h3>
                                <table border={1}
                                       style={{width: '100%', maxWidth: '700px', borderCollapse: 'collapse'}}>
                                    <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Label</th>
                                        <th>Action</th>
                                        <th>X</th>
                                        <th>Y</th>
                                        <th>Width</th>
                                        <th>Height</th>
                                        <th>Threshold</th>
                                        <th>Scale X</th>
                                        <th>Scale Y</th>
                                        <th>Digits Only</th>
                                        <th>Processed Image</th>
                                        <th>OCR Result</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    {selections.map((rect, index) => (
                                        <tr key={index}
                                            style={{backgroundColor: referenceIndex === index ? '#e0ffe0' : redrawIndex === index ? '#f0f0f0' : 'transparent'}}>
                                            <td>{index + 1}</td>
                                            <td>
                                                <input type="text" value={rect.label}
                                                       onChange={(e) => handleSelectionParamChange(index, 'label', e.target.value)}
                                                       style={{width: '80px'}}/>
                                            </td>
                                            <td style={{textAlign: 'center'}}>
                                                <button onClick={() => setReferenceIndex(index)}
                                                        disabled={isSeeking}>{referenceIndex === index ? 'Reference' : 'Set as Ref'}</button>
                                                <button onClick={() => handleRedraw(index)}
                                                        disabled={(redrawIndex !== null && redrawIndex !== index) || isSeeking}
                                                        style={{marginLeft: '5px'}}>
                                                    {redrawIndex === index ? 'Redrawing...' : 'Redraw'}
                                                </button>
                                                <button onClick={() => handleDeleteSelection(index)}
                                                        style={{marginLeft: '5px'}}
                                                        disabled={redrawIndex !== null || isSeeking}>
                                                    Delete
                                                </button>
                                            </td>
                                            <td>{rect.x.toFixed(0)}</td>
                                            <td>{rect.y.toFixed(0)}</td>
                                            <td>{rect.width.toFixed(0)}</td>
                                            <td>{rect.height.toFixed(0)}</td>
                                            <td>
                                                <input type="number" value={rect.threshold}
                                                       onChange={(e) => handleSelectionParamChange(index, 'threshold', parseInt(e.target.value, 10))}
                                                       min={0} max={255} style={{width: '50px'}}/>
                                            </td>
                                            <td>
                                                <input type="number" value={rect.scaleX}
                                                       onChange={(e) => handleSelectionParamChange(index, 'scaleX', parseFloat(e.target.value))}
                                                       min={0.1} step={0.1} style={{width: '50px'}}/>
                                            </td>
                                            <td>
                                                <input type="number" value={rect.scaleY}
                                                       onChange={(e) => handleSelectionParamChange(index, 'scaleY', parseFloat(e.target.value))}
                                                       min={0.1} step={0.1} style={{width: '50px'}}/>
                                            </td>
                                            <td style={{textAlign: 'center'}}>
                                                <input type="checkbox" checked={rect.digitsOnly}
                                                       onChange={(e) => handleSelectionParamChange(index, 'digitsOnly', e.target.checked)}/>
                                            </td>
                                            <td>
                                                {processedImages[index] &&
                                                    <img src={processedImages[index]}
                                                         alt={`Processed selection ${index + 1}`}
                                                         style={{height: '40px'}}/>
                                                }
                                            </td>
                                            <td>{ocrResults[index] || ''}</td>
                                        </tr>
                                    ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <canvas
                            ref={canvasRef}
                            style={{
                                marginTop: '20px',
                                border: '1px solid black',
                                cursor: isSelectionEnabled ? 'crosshair' : 'default'
                            }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp}
                            onMouseLeave={handleMouseUp}
                        />
                    </div>
                )}
            </header>
        </div>
    );
}
