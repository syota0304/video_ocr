import {useState, type ChangeEvent, useRef, type MouseEvent, useEffect, useCallback} from 'react';
import './App.css';
import Tesseract from 'tesseract.js';
import cvReadyPromise from "@techstark/opencv-js";

const getLevenshteinDistance = (a: string, b: string): number => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) {
        matrix[0][i] = i;
    }

    for (let j = 0; j <= b.length; j++) {
        matrix[j][0] = j;
    }

    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1, // deletion
                matrix[j - 1][i] + 1, // insertion
                matrix[j - 1][i - 1] + substitutionCost // substitution
            );
        }
    }

    return matrix[b.length][a.length];
};

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
    scaleY: 5,
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
        label: 'SCRATCH',
        x: 509,
        y: 526,
        width: 104,
        height: 22,
    },
    {
        label: 'SOF-LAN',
        x: 828,
        y: 527,
        width: 107,
        height: 23,
    },
].map(e => ({...defaultSelection, ...e,}))

const defaultPerspectivePoints = [
    {x: 488, y: 139},
    {x: 1335, y: 157},
    {x: 1462, y: 916},
    {x: 446, y: 1013},
]

type outputData = {
    musicId: number;
    notes: number;
    chord: number;
    peak: number;
    charge: number;
    scratch: number;
    soflan: number;
}

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
    const [selectedCorrections, setSelectedCorrections] = useState<(string | null)[]>([]);
    const [selectedCorrectionIds, setSelectedCorrectionIds] = useState<(number | null)[]>([]);
    const [correctionSuggestions, setCorrectionSuggestions] = useState<Array<Array<{ title: string, id: number, distance: number }>>>([]);
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
    const [outputData, setOutputData] = useState<outputData[]>([]);

    // State for master data
    type MasterData = {
        title: string,
        id: number,
    }
    const [titleMasterData, setTitleMasterData] = useState<MasterData[]>([]);
    const [showMasterDataInput, setShowMasterDataInput] = useState(true);
    const [masterDataJson, setMasterDataJson] = useState('');


    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            setVideoSrc(url);
            setCapturedImage(null);
            setSelections(defaultSelections);
            setOcrResults([]);
            setSelectedCorrections([]);
            setSelectedCorrectionIds([]);
            setCorrectionSuggestions([]);
            setProcessedImages([]);
            setRedrawIndex(null);
            setIsSeeking(false);
            setPerspectivePoints(defaultPerspectivePoints);
            setOutputData([]);
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
                setSelectedCorrections([]);
                setSelectedCorrectionIds([]);
                setCorrectionSuggestions([]);
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

    const handleLoadMasterData = () => {
        if (!masterDataJson.trim()) {
            alert('JSONデータを貼り付けてください。');
            return;
        }
        try {
            const data = (JSON.parse(masterDataJson)).data.music;
            console.log(data)
            // Basic validation: check if it's an array of strings
            if (Array.isArray(data) && data.every(item => typeof item === 'object')) {
                setTitleMasterData(data);
                setShowMasterDataInput(false);
                alert('マスタデータの読み込みに成功しました！');
            } else {
                alert('不正なJSONフォーマットです。');
            }
        } catch (error) {
            console.error('Failed to parse master data JSON:', error);
            alert('JSONの解析に失敗しました。フォーマットを確認してください。');
        }
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

    const handleAddToOutput = () => {
        const getCorrectionValue = (label: string): string | null => {
            const index = selections.findIndex(s => s.label === label);
            return index !== -1 ? selectedCorrections[index] : null;
        };

        const getCorrectionId = (label: string): number | null => {
            const index = selections.findIndex(s => s.label === label);
            return index !== -1 ? selectedCorrectionIds[index] : null;
        }

        const musicId = getCorrectionId('TITLE');
        if (musicId === null) {
            alert('TITLEが選択されていません。');
            return;
        }

        // Check for duplicates
        if (outputData.some(item => item.musicId === musicId)) {
            alert(`Music ID ${musicId} は既に追加されています。`);
            return;
        }

        const newOutput: outputData = {
            musicId: musicId,
            notes: parseFloat(getCorrectionValue('NOTES') || '0'),
            chord: parseFloat(getCorrectionValue('CHORD') || '0'),
            peak: parseFloat(getCorrectionValue('PEAK') || '0'),
            charge: parseFloat(getCorrectionValue('CHARGE') || '0'),
            scratch: parseFloat(getCorrectionValue('SCRATCH') || '0'),
            soflan: parseFloat(getCorrectionValue('SOF-LAN') || '0'),
        };

        setOutputData(prev => [...prev, newOutput].sort((a, b) => a.musicId - b.musicId));
    };

    const handleDownloadJson = () => {
        if (outputData.length === 0) {
            alert('ダウンロードするデータがありません。');
            return;
        }
        const jsonString = JSON.stringify({data: outputData}, null, 2);
        const blob = new Blob([jsonString], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'output.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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

    useEffect(() => {
        if (ocrResults.length === 0 || titleMasterData.length === 0) {
            setCorrectionSuggestions([]);
            setSelectedCorrectionIds([]);
            setSelectedCorrections([]);
            return;
        }

        const performSimpleCorrection = (text: string): string => {
            if (!text) return '';
            text = text
                .replace(/I/g, '1')
                .replace(/i/g, '1')
                .replace(/l/g, '1')
                .replace(/\|/g, '1')
                .replace(/Z/g, '2')
                .replace(/A/g, '4')
                .replace(/q/g, '4')
                .replace(/S/g, '5')
                .replace(/b/g, '6')
                .replace(/G/g, '6')
                .replace(/o/g, '0')
                .replace(/O/g, '0');

            if(!text.includes('.')){
                text = text.replace(/(.*) /, "$1.")
            }

            text = text.replace(/[^0-9.]/g, "")

            if(!text.includes('.')){
                const insertIndex = text.length - 2; // 5 - 2 = 3

                const firstPart = text.slice(0, insertIndex); // "abc"
                const secondPart = text.slice(insertIndex); // "de"

                text = firstPart + "." + secondPart; // "abcXYZde"
            }

            if(text.indexOf(".") > 3){
                const length = text.indexOf(".")
                text = text.slice(length - 3)
            }

            if(text.slice(text.indexOf("."), text.length).length  > 3){
                text = text.slice(0, text.indexOf(".") + 3)
            }

            return text;
        };

        const newSuggestions: Array<Array<{ title: string, id: number, distance: number }>> = Array.from({length: selections.length}, () => []);
        const newSelectedCorrections: (string | null)[] = Array(selections.length).fill(null);
        const newSelectedCorrectionIds: (number | null)[] = Array(selections.length).fill(null);

        ocrResults.forEach((ocrText, index) => {
            const selectionLabel = selections[index]?.label;
            if (selectionLabel === 'TITLE' && ocrText.trim() && titleMasterData.length > 0) {
                const suggestions = titleMasterData.map(masterItem => ({
                    title: masterItem.title,
                    id: masterItem.id,
                    distance: getLevenshteinDistance(ocrText.trim(), masterItem.title)
                })).sort((a, b) => a.distance - b.distance).slice(0, 10);

                newSuggestions[index] = suggestions;
                newSelectedCorrections[index] = suggestions[0]?.title || ''; // Set best match as default
                newSelectedCorrectionIds[index] = suggestions[0]?.id ?? null;
            } else if (['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SOF-LAN', 'SCRATCH'].includes(selectionLabel)) {
                newSelectedCorrections[index] = performSimpleCorrection(ocrText);
            }
        });

        setCorrectionSuggestions(newSuggestions);
        setSelectedCorrections(newSelectedCorrections);
        setSelectedCorrectionIds(newSelectedCorrectionIds);

    }, [ocrResults, titleMasterData, selections]);

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
                {showMasterDataInput && (
                    <div style={{
                        margin: '10px 0',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        maxWidth: '700px',
                        width: '100%'
                    }}>
                        <a href={"https://asia-northeast1-iidx-viewer.cloudfunctions.net/getMasterData"} target={"_blank"}>マスタデータ</a>
                        <textarea rows={5}
                                  placeholder='上記リンクの内容をすべて選択してコピペしてください'
                                  value={masterDataJson} onChange={(e) => setMasterDataJson(e.target.value)}
                                  style={{width: '100%', padding: '5px'}}/>
                        <button onClick={handleLoadMasterData} style={{alignSelf: 'flex-start'}}>マスタデータを読み込む</button>
                    </div>
                )}
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
                                    <button onClick={handleAddToOutput} style={{marginLeft: '10px'}}>
                                        出力に追加
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
                                        <th>補正値</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    {selections.map((rect, index) => {
                                        const currentCorrection = selectedCorrections[index] ?? '';
                                        const manualSuggestions = currentCorrection.length > 1
                                            ? titleMasterData
                                                .filter(item => item.title.toLowerCase().includes(currentCorrection.toLowerCase()))
                                                .slice(0, 10)
                                            : [];

                                        return (
                                            <tr key={index}>
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
                                                    <div style={{width: "350px", overflowX: "auto", whiteSpace: "nowrap"}}>
                                                        {processedImages[index] &&
                                                            <img src={processedImages[index]}
                                                                 alt={`Processed selection ${index + 1}`}
                                                            />
                                                        }
                                                    </div>
                                                </td>
                                                <td style={{whiteSpace: "nowrap"}}>{ocrResults[index] || ''}</td>
                                                <td>
                                                    {selections[index].label === 'TITLE' ? (
                                                        <div style={{display: 'flex', flexDirection: 'column', gap: '5px'}}>
                                                            {correctionSuggestions[index]?.length > 0 && (
                                                                <select
                                                                    value={selectedCorrectionIds[index] ?? ''}
                                                                    onChange={(e) => {
                                                                        const newId = parseInt(e.target.value, 10);
                                                                        const selectedItem = titleMasterData.find(item => item.id === newId);
                                                                        if (selectedItem) {
                                                                            const newSelected = [...selectedCorrections];
                                                                            newSelected[index] = selectedItem.title;
                                                                            setSelectedCorrections(newSelected);

                                                                            const newIds = [...selectedCorrectionIds];
                                                                            newIds[index] = selectedItem.id;
                                                                            setSelectedCorrectionIds(newIds);
                                                                        }
                                                                    }}
                                                                >
                                                                    {correctionSuggestions[index]?.map((suggestion) => (
                                                                        <option key={suggestion.id} value={suggestion.id}>
                                                                            {suggestion.title} (dist: {suggestion.distance})
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                            )}
                                                            <input
                                                                type="text"
                                                                list={`manual-suggestions-${index}`}
                                                                placeholder="または手動で入力"
                                                                value={currentCorrection}
                                                                onChange={(e) => {
                                                                    const newSelected = [...selectedCorrections];
                                                                    const newTitle = e.target.value;
                                                                    newSelected[index] = newTitle;
                                                                    setSelectedCorrections(newSelected);

                                                                    const newIds = [...selectedCorrectionIds];
                                                                    const matchedItem = titleMasterData.find(item => item.title === newTitle);
                                                                    newIds[index] = matchedItem?.id ?? null;
                                                                    setSelectedCorrectionIds(newIds);
                                                                }}
                                                            />
                                                            <datalist id={`manual-suggestions-${index}`}>
                                                                {manualSuggestions.map((suggestion) => (
                                                                    <option key={suggestion.id} value={suggestion.title}/>
                                                                ))}
                                                            </datalist>
                                                        </div>
                                                    ) : (
                                                        <input
                                                            type="text"
                                                            value={selectedCorrections[index] || ''}
                                                            onChange={(e) => {
                                                                const newSelected = [...selectedCorrections];
                                                                newSelected[index] = e.target.value;
                                                                setSelectedCorrections(newSelected);
                                                            }}
                                                            style={{maxWidth: '300px', width: '100%'}}
                                                        />
                                                    )
                                                    }
                                                </td>
                                            </tr>
                                        );
                                    })}
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

                {outputData.length > 0 && (
                    <div style={{marginTop: '20px', width: '100%', maxWidth: '700px'}}>
                        <h3>Output Data</h3>
                        <textarea
                            readOnly
                            rows={10}
                            value={JSON.stringify({data: outputData}, null, 2)}
                            style={{width: '100%', fontFamily: 'monospace'}}
                        />
                        <>
                            <button onClick={handleDownloadJson} style={{marginTop: '5px'}}>
                                JSONをダウンロード
                            </button>
                        </>
                    </div>
                )}
            </header>
        </div>
    );
}
