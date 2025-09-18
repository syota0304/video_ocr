import {useState, type ChangeEvent, useRef, type MouseEvent, useEffect, useCallback} from 'react';
import './App.css';
import Tesseract from 'tesseract.js';
import cvReadyPromise from "@techstark/opencv-js";

interface SelectionRect {
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    threshold: number;
    scaleX: number;
    scaleY: number;
    negative: boolean
}

const defaultSelection: SelectionRect = {
    label: '',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    threshold: 150,
    scaleX: 3,
    scaleY: 3,
    negative: true,
};

const defaultSelections: SelectionRect[] = [
    {
        label: 'TITLE',
        x: 43,
        y: 563,
        width: 867,
        height: 42,
        scaleX: 1,
        scaleY: 1,
    },
    {
        label: 'NOTES',
        x: 196,
        y: 505,
        width: 107,
        height: 20,
    },
    {
        label: 'CHORD',
        x: 508,
        y: 505,
        width: 108,
        height: 20,
    },
    {
        label: 'PEAK',
        x: 828,
        y: 503,
        width: 104,
        height: 23,
    },
    {
        label: 'CHARGE',
        x: 196,
        y: 527,
        width: 106,
        height: 21,
    },
    {
        label: 'SOF-LAN',
        x: 509,
        y: 526,
        width: 107,
        height: 23,
    },
    {
        label: 'SCRATCH',
        x: 828,
        y: 527,
        width: 104,
        height: 22,
    },
].map(e => ({...defaultSelection, ...e,}))

const defaultPerspectivePoints = [
    {x: 488, y: 139},
    {x: 1335, y: 157},
    {x: 1462, y: 916},
    {x: 446, y: 1013},
]

export function App() {
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [capturedImage, setCapturedImage] = useState<ImageData | null>(null);
    const [frameRate, setFrameRate] = useState(60);

    const [isDrawing, setIsDrawing] = useState(false);
    const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
    const [endPoint, setEndPoint] = useState<{ x: number; y: number } | null>(null);
    const [selections, setSelections] = useState<SelectionRect[]>(defaultSelections);
    const [ocrResults, setOcrResults] = useState<string[]>([]);
    const [isOcrRunning, setIsOcrRunning] = useState(false);
    const [processedImages, setProcessedImages] = useState<string[]>([]);
    const [redrawIndex, setRedrawIndex] = useState<number | null>(null);

    const cvRef = useRef<any>(null);
    const [isCvReady, setIsCvReady] = useState(false);
    // State for auto-seeking
    const [isSeeking, setIsSeeking] = useState(false);
    const [diffThreshold, setDiffThreshold] = useState(20); // Default difference sensitivity
    const referenceImageData = useRef<ImageData | null>(null);
    // State for perspective transform
    const [perspectivePoints, setPerspectivePoints] = useState<{ x: number, y: number }[]>(defaultPerspectivePoints);
    const [isSettingPerspective, setIsSettingPerspective] = useState(false);


    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            setVideoSrc(url);
            setCapturedImage(null);
            setSelections(defaultSelections);
            setOcrResults([]);
            setProcessedImages([]);
            setRedrawIndex(null);
            setIsSeeking(false);
            setPerspectivePoints(defaultPerspectivePoints);
            setIsSettingPerspective(false);
        }
    };

    const captureFrame = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const cv = cvRef.current;

        if (video && canvas && !video.paused) video.pause();
        if (video && canvas && cv) {
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (context) {
                // Draw video to a temporary canvas to get ImageData
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = video.videoWidth;
                tempCanvas.height = video.videoHeight;
                const tempCtx = tempCanvas.getContext('2d');
                if (!tempCtx) return;
                tempCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                const frameImageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);

                if (perspectivePoints.length === 4) {
                    // Apply perspective transform
                    const src = cv.matFromImageData(frameImageData);
                    const [tl, tr, br, bl] = perspectivePoints;
                    const widthA = Math.sqrt(Math.pow(br.x - bl.x, 2) + Math.pow(br.y - bl.y, 2));
                    const widthB = Math.sqrt(Math.pow(tr.x - tl.x, 2) + Math.pow(tr.y - tl.y, 2));
                    const maxWidth = Math.max(widthA, widthB);
                    const heightA = Math.sqrt(Math.pow(tr.x - br.x, 2) + Math.pow(tr.y - br.y, 2));
                    const heightB = Math.sqrt(Math.pow(tl.x - bl.x, 2) + Math.pow(tl.y - bl.y, 2));
                    const maxHeight = Math.max(heightA, heightB);

                    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
                    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxWidth, 0, maxWidth, maxHeight, 0, maxHeight]);
                    const M = cv.getPerspectiveTransform(srcTri, dstTri);
                    const dsize = new cv.Size(maxWidth, maxHeight);
                    const warped = new cv.Mat();
                    cv.warpPerspective(src, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

                    canvas.width = maxWidth;
                    canvas.height = maxHeight;
                    cv.imshow(canvas, warped);
                    setCapturedImage(context.getImageData(0, 0, canvas.width, canvas.height));

                    src.delete();
                    M.delete();
                    srcTri.delete();
                    dstTri.delete();
                    warped.delete();
                } else {
                    // No transform, just use the original frame
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    context.putImageData(frameImageData, 0, 0);
                    setCapturedImage(frameImageData);
                }
                setOcrResults([]);
                setProcessedImages([]);
            }
        }
    }, [perspectivePoints]);

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
        if (!capturedImage) return;

        if (isSettingPerspective) {
            const pos = getCanvasCoordinates(event);
            setPerspectivePoints(prev => {
                const newPoints = [...prev, pos];
                // Reset if more than 4 points are clicked
                if (newPoints.length >= 4) {
                    setIsSettingPerspective(false);
                }
                return newPoints;
            });
            return;
        }
        if (redrawIndex === null) return;
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
            }
        }

        setIsDrawing(false);
        setStartPoint(null);
        setEndPoint(null);
    };

    const handleRedraw = (index: number) => {
        setRedrawIndex(index);
    };

    const handleSettingPerspective = () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (video && canvas) {
            const context = canvas.getContext('2d');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context?.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
            setCapturedImage(context?.getImageData(0, 0, canvas.width, canvas.height) ?? null);
        }
        setPerspectivePoints([]);
        setIsSettingPerspective(true);
    }

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

        const scheduler = Tesseract.createScheduler();

        try {
            const worker = await Tesseract.createWorker('eng');
            scheduler.addWorker(worker);

            const jobPromises = selections.map((_selection, index) => {
                const imageUrl = processedImages[index];
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
            await scheduler.terminate();
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

    // Effect to handle OpenCV.js initialization
    useEffect(() => {
        const initializeCv = async () => {
            try {
                // Promiseが解決されるのを待ち、解決されたcvオブジェクトをrefに格納します。
                cvRef.current = await cvReadyPromise;
                console.log("OpenCV.js is ready!");
                // ビルド情報をログに出力して、正しくロードされたことを確認します。
                console.log(cvRef.current.getBuildInformation());
                setIsCvReady(true);
            } catch (error) {
                console.error("Error initializing OpenCV.js", error);
            }
        };
        initializeCv();
    }, []);

    // Effect to pre-process images for table display
    useEffect(() => {
        // OpenCV.jsの準備が完了し、画像がキャプチャされるまで待機します
        if (!isCvReady || !capturedImage || !canvasRef.current) return;

        const cv = cvRef.current;
        if (!cv) return;

        const mainContext = canvasRef.current.getContext('2d');
        if (!mainContext) return;

        const urls = selections.map(rect => {
            if (rect.width <= 0 || rect.height <= 0 || rect.scaleX <= 0 || rect.scaleY <= 0) {
                return '';
            }

            let src = null;
            let dst = null;
            try {
                // 選択範囲のImageDataを取得
                const originalImageData = mainContext.getImageData(rect.x, rect.y, rect.width, rect.height);
                src = cv.matFromImageData(originalImageData);
                dst = new cv.Mat();

                // 画像をリサイズ
                const dsize = new cv.Size(Math.round(rect.width * rect.scaleX), Math.round(rect.height * rect.scaleY));
                cv.resize(src, dst, dsize, 0, 0, cv.INTER_LANCZOS4);

                // グレースケールに変換
                cv.cvtColor(dst, dst, cv.COLOR_RGBA2GRAY, 0);

                // 2値化（ネガポジ反転も考慮）
                const thresholdType = rect.negative ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY;
                cv.threshold(dst, dst, rect.threshold, 255, thresholdType);

                // 結果をCanvasに描画してDataURLを取得
                const tempCanvas = document.createElement('canvas');
                cv.imshow(tempCanvas, dst);
                return tempCanvas.toDataURL();
            } finally {
                // メモリリークを防ぐためにMatオブジェクトを解放
                src?.delete();
                dst?.delete();
            }
        });
        setProcessedImages(urls);

    }, [selections, capturedImage, isCvReady]); // Removed perspectivePoints from dependencies

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
        if (!videoRef.current || !canvasRef.current) return;

        const video = videoRef.current;
        const mainCtx = canvasRef.current.getContext('2d', {willReadFrequently: true});
        if (!mainCtx) return;

        const referenceIndex = 0;

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

    }, [selections, frameRate, diffThreshold, captureFrame]);

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
            else context.strokeStyle = 'blue';
            context.strokeRect(rect.x, rect.y, rect.width, rect.height);
        });

        // Draw perspective points and lines ONLY when setting them
        // The result of the transform is already on the canvas.
        if (isSettingPerspective && perspectivePoints.length > 0) {
            context.strokeStyle = 'lime';
            context.fillStyle = 'lime';
            context.lineWidth = 1;
            context.beginPath();
            const [start, ...rest] = perspectivePoints;
            context.moveTo(start.x, start.y);
            rest.forEach(p => context.lineTo(p.x, p.y));
            if (perspectivePoints.length === 4) {
                context.closePath();
            }
            context.stroke();

            perspectivePoints.forEach((p, i) => {
                context.beginPath();
                context.arc(p.x, p.y, 5, 0, 2 * Math.PI);
                context.fill();
                context.fillText(`${i + 1}`, p.x + 8, p.y + 8);
            });
        }

        if (isDrawing && startPoint && endPoint) {
            context.strokeStyle = 'red';
            context.strokeRect(startPoint.x, startPoint.y, endPoint.x - startPoint.x, endPoint.y - startPoint.y);
        }
    }, [capturedImage, selections, isDrawing, startPoint, endPoint, redrawIndex, isSettingPerspective, perspectivePoints]);

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
                            <button onClick={handleSettingPerspective} disabled={!videoSrc || isSettingPerspective}>
                                台形補正範囲を設定
                            </button>
                            <label style={{marginLeft: '10px'}}>
                                {isSettingPerspective ? `点をクリックしてください (${perspectivePoints.length}/4)` : `${perspectivePoints.length === 4 ? '設定済' : '未設定'}`}
                                {perspectivePoints.length === 4 && perspectivePoints.map((p) =>
                                    (`(${p.x.toFixed(0)},${p.y.toFixed(0)})`)).join(", ")}
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
                                    <button onClick={runOCR} disabled={isOcrRunning || selections.length === 0}
                                            style={{marginLeft: '10px'}}>
                                        {isOcrRunning ? 'Processing...' : 'Run OCR (Space)'}
                                    </button>
                                </>
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
                                <button onClick={() => setIsSeeking(!isSeeking)}>
                                    {isSeeking ? 'Stop Seeking' : 'Find Next Change'}
                                </button>
                                <label>
                                    Diff Threshold:
                                    <input type="number" value={diffThreshold}
                                           onChange={(e) => setDiffThreshold(parseInt(e.target.value, 10) || 20)}
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
                                        <th>Processed Image</th>
                                        <th>OCR Result</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    {selections.map((rect, index) => (
                                        <tr key={index}
                                            style={{backgroundColor: redrawIndex === index ? '#f0f0f0' : 'transparent'}}>
                                            <td>{index + 1}</td>
                                            <td>
                                                {rect.label}
                                            </td>
                                            <td style={{textAlign: 'center'}}>
                                                <button onClick={() => handleRedraw(index)}
                                                        disabled={(redrawIndex !== null && redrawIndex !== index) || isSeeking || isSettingPerspective}
                                                        style={{marginLeft: '5px'}}>
                                                    {redrawIndex === index ? '範囲設定中' : '範囲設定'}
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
                                cursor: (redrawIndex !== null || isSettingPerspective) ? 'crosshair' : 'default'
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
