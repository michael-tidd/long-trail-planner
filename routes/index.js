var express = require('express');
var router = express.Router();
var convert = require('xml-js');
var fs = require('fs');
const {parse} = require("json2csv/lib/json2csv");

const METERS_TO_FEET = 3.28084;
let HORZ_MPH = 2.3;
let VERT_FPH = 1600;
let DESC_FPH  = 3000;
const ACTUAL_TOTAL_DISTANCE = 272;
const ACTUAL_TOTAL_ELEVATION = 77000;
let IS_SOUTHBOUND = false;

let START_MONTH = 9;
let START_DAY = 16;
let START_HOUR = 1;
let START_MIN = 30;

let restIndex = 0;
let lastRest = 0;

const BASE_WEIGHT = 10;
const FOOD_WEIGHT = 14;
const BODY_WEIGHT = 190;

/* GET home page. */
router.get('/', function(req, res, next) {
  // res.render('index', { title: 'Express' });

  if(req.query.hs !== undefined){
    HORZ_MPH = parseFloat(req.query.hs);
  }

  if(req.query.vs !== undefined){
    VERT_FPH = parseFloat(req.query.vs);
  }

  if(req.query.ds !== undefined){
    DESC_FPH = parseFloat(req.query.ds);
  }
  DESC_FPH = DESC_FPH * -1;

  if(req.query.sh !== undefined){
    START_HOUR = parseFloat(req.query.sh);
  }

  if(req.query.sm !== undefined){
    START_MIN = parseFloat(req.query.sm);
  }

  if(req.query.sb !== undefined){
    IS_SOUTHBOUND = true;
  }

  // XML JS START
  let wProm = getData('./data/long-trail-waypoints.json');
  let tProm = getData('./data/long-trail-w-elevation.gpx');


  Promise.all([tProm,wProm]).then(result => {
    let xml = result[0];
    let wResult = JSON.parse(result[1]);
    let tResult = JSON.parse(convert.xml2json(xml, {compact: true, spaces: 4}));
    res.setHeader('Content-Type', 'application/json');
    let trackpoints = tResult.gpx.trk.trkseg.trkpt.map((trackpoint) => {
      return {lat: trackpoint._attributes.lat, lon: trackpoint._attributes.lon, ele: trackpoint.ele._text};
    });

    let waypoints = wResult.waypoints;

    if(IS_SOUTHBOUND){
      waypoints = waypoints.reverse();
    } else {
      trackpoints = trackpoints.reverse();
    }


    waypoints = waypoints.filter(waypoint => waypoint.eleFt > 0);

    // initialize trackpoints with indexes and measured distances
    let previousTrackpoint = null;
    let totalDistance = 0;
    trackpoints.forEach((trackpoint, index) => {
      trackpoint.index = index;
      if(previousTrackpoint != null){
        let distance = getHaversineDistance([previousTrackpoint.lon, previousTrackpoint.lat], [trackpoint.lon, trackpoint.lat], true)
        trackpoint.splitDistance = distance;
      } else {
        trackpoint.splitDistance = 0;
      }
      totalDistance += trackpoint.splitDistance;
      trackpoint.totalDistance = totalDistance;
      previousTrackpoint = trackpoint;
    });

    // initially pair waypoints to trackpoints
    waypoints.forEach(waypoint => {
      let minDistance = Number.MAX_VALUE;
      trackpoints.forEach(trackpoint => {
        let distance = getHaversineDistance([waypoint.lon, waypoint.lat], [trackpoint.lon, trackpoint.lat], true)
        if (distance < minDistance) {
          minDistance = distance;
          waypoint.closestTrackpointIndex = trackpoint.index;
        }
      });
    });

    // calculate the error between the measured distances and the known distances
    // also assign technical factor from waypoints to trackpoints
    let previousWaypoint = null;
    waypoints.forEach(waypoint => {

      if(IS_SOUTHBOUND) {
        waypoint.totalDst = ACTUAL_TOTAL_DISTANCE - waypoint.totalDst;
      }

      let closestTrackpoint = trackpoints[waypoint.closestTrackpointIndex];

      if(previousWaypoint){
        let previousClosestTrackpoint = trackpoints[previousWaypoint.closestTrackpointIndex];
        waypoint.trackpointError = (waypoint.totalDst - previousWaypoint.totalDst)/(closestTrackpoint.totalDistance - previousClosestTrackpoint.totalDistance);
      } else {
        waypoint.trackpointError = waypoint.totalDst / closestTrackpoint.totalDistance;
      }

      if(waypoint.trackpointError < 1){
        waypoint.trackpointError = 1;
      }


      trackpoints.forEach((trackpoint, index) => {
        if(!trackpoint.error && index <= waypoint.closestTrackpointIndex) {
          trackpoint.error = waypoint.trackpointError;
          trackpoint.technicalFactor = waypoint.tecFactor;
        }
      });

      previousWaypoint = waypoint;
    });

    // recalculate trackpoint stats based on errors
    totalDistance = 0;
    trackpoints.forEach(trackpoint => {
      if(trackpoint.error > 1){
        trackpoint.splitDistance = trackpoint.splitDistance * trackpoint.error;
      }
      totalDistance += trackpoint.splitDistance;
      trackpoint.totalDistance = totalDistance;
    });

    let elevationGain = 0;
    previousTrackpoint = null;
    trackpoints.forEach(trackpoint => {
      // assign elevation data
      if (previousTrackpoint) {
        trackpoint.splitElevation = trackpoint.ele - previousTrackpoint.ele;
      } else {
        trackpoint.splitElevation = 0;
      }

      // calculate total elevation gain
      if( trackpoint.splitElevation > 0 ) {
        elevationGain += trackpoint.splitElevation;
      }

      previousTrackpoint = trackpoint;
    });

    // calculate times
    let totalMovingTime = 0;
    let totalElevationGain = 0;
    let totalElevationDrop = 0;
    let days = 1;

    let totalRestTime = 0;
    let totalWeightTime = 0;
    trackpoints.forEach(trackpoint => {
      let xTime = trackpoint.splitDistance / HORZ_MPH;
      trackpoint.slope = (trackpoint.splitElevation * METERS_TO_FEET) / (trackpoint.splitDistance * 5280);
      if(trackpoint.slope < -.15){

        // xTime = trackpoint.splitDistance / (HORZ_MPH / 2); // adjusted speed for steep downhills
      }

      let yTime = (trackpoint.splitElevation * METERS_TO_FEET) / VERT_FPH;
      yTime = Math.max(yTime, 0);

      if(trackpoint.slope < 0){
        yTime = (trackpoint.splitElevation * METERS_TO_FEET) / -1 * DESC_FPH;
        yTime = Math.max(yTime, 0);
      }


      let maxTime = yTime;
      if(xTime > yTime){
        maxTime = xTime + (.5 * yTime);
      }



      // trackpoint.splitTime = Math.max(xTime, yTime) * (1 + trackpoint.technicalFactor) * 60;

      let splitDistanceInFeet = trackpoint.splitDistance * 5280;

      trackpoint.splitTime = maxTime * 60;
      totalMovingTime += trackpoint.splitTime;
      trackpoint.totalMovingTime = totalMovingTime; // in minutes

      lastRest += trackpoint.splitTime;
      let restTime = 0;
      if(lastRest >= 5 * 60){
        if(restIndex == 0 || restIndex == 2){
          // 15 minute breaks at 5 and 15 hours
          restTime = 15;
        } else if(restIndex == 1){
          // 30 minute breaks at 10 hours
          restTime = 30;
        } else if(restIndex == 3) {
          // 4 hours sleep at 20 hours
          if(days < 3.5){
            // full sleep for 3 nights
            restTime = (4*60);
            console.log('sleep');
          } else if(days < 6){
            // nap for one night
            restTime = (2*60);
            console.log('nap');
          }  else {
            // push through the rest
            restTime = 30
            console.log('push');
          }
          restIndex = -1;
          days ++;
        }
        restIndex ++;
        lastRest = 0;
      }

      totalRestTime += restTime;
      trackpoint.restTime = restTime;
      trackpoint.totalRestTime = totalRestTime;

      trackpoint.progress = (IS_SOUTHBOUND ? ACTUAL_TOTAL_DISTANCE - trackpoint.totalDistance : trackpoint.totalDistance) / ACTUAL_TOTAL_DISTANCE;
      trackpoint.weight = (1-trackpoint.progress) * FOOD_WEIGHT + BASE_WEIGHT;
      let weightPct = 100 * (trackpoint.weight / BODY_WEIGHT);
      let weightPenalty = (6 * weightPct)/60; // minutes per mile
      let weightTime = weightPenalty * trackpoint.splitDistance;

      totalWeightTime += weightTime;
      trackpoint.weightTime = weightTime;
      trackpoint.totalWeightTime = totalWeightTime;

      if(trackpoint.splitElevation > 0){
        totalElevationGain += trackpoint.splitElevation;
      } else {
        totalElevationDrop += trackpoint.splitElevation;
      }
      trackpoint.totalElevationGain = totalElevationGain;
      trackpoint.totalElevationDrop = totalElevationDrop;
    });

    // calculate elapsed times
    previousTrackpoint = null;
    trackpoints.forEach(trackpoint => {

      if(previousTrackpoint){
        trackpoint.elapsedTime = trackpoint.splitTime + previousTrackpoint.totalMovingTime + trackpoint.restTime + previousTrackpoint.totalRestTime + trackpoint.weightTime + previousTrackpoint.totalWeightTime;
      } else {
        trackpoint.elapsedTime = trackpoint.splitTime + trackpoint.totalRestTime + trackpoint.totalWeightTime;
      }

      previousTrackpoint = trackpoint;
    });

    previousWaypoint = null;
    waypoints.forEach(waypoint => {
      let closestTrackpoint = trackpoints[waypoint.closestTrackpointIndex];
      waypoint.totalMovingTime = closestTrackpoint.totalMovingTime;
      waypoint.totalRestTime = closestTrackpoint.totalRestTime;
      waypoint.totalElevationGain = closestTrackpoint.totalElevationGain;
      waypoint.totalElevationDrop = closestTrackpoint.totalElevationDrop;
      waypoint.elapsedTime = closestTrackpoint.elapsedTime; // in hours
      waypoint.weight = closestTrackpoint.weight;
      waypoint.weightTime = closestTrackpoint.weightTime;

      if(previousWaypoint){
        waypoint.restTime = waypoint.totalRestTime - previousWaypoint.totalRestTime;
        waypoint.splitDistance = waypoint.totalDst - previousWaypoint.totalDst;
        waypoint.splitElevationGain = waypoint.totalElevationGain - previousWaypoint.totalElevationGain;
        waypoint.splitElevationDrop = waypoint.totalElevationDrop - previousWaypoint.totalElevationDrop;
        waypoint.splitTime = waypoint.totalMovingTime - previousWaypoint.totalMovingTime;
        waypoint.splitSpeed = waypoint.splitDistance / (waypoint.splitTime / 60);
      } else {
        waypoint.splitDistance = 0;
      }

      previousWaypoint = waypoint;
    });

    let jgStart = new Date(waypoints[0].jG);
    let mtStart = new Date(waypoints[0].mT);
    let jpStart = new Date(waypoints[0].jP);
    let twStart = new Date(waypoints[0].tW);

    let maxSplitTime = 0;
    waypoints.forEach(waypoint => {
      // waypoint.baselineProgress = waypoint.closestTrackpoint.baselineProgress * 100;
      // waypoint.baselineTime = waypoint.closestTrackpoint.baselineTime / 24;
      // waypoint.baselineSpeed = waypoint.closestTrackpoint.baselineSpeed;
      // waypoint.speedPercentage = waypoint.baselineSpeed / HORZ_MPH;



      if(waypoint.jG !== undefined){
        let jgTime = new Date(waypoint.jG);
        waypoint.jgTime = ((jgTime.getTime() - jgStart.getTime())/1000)/ 60;
      }

      if(!waypoint['jgTime']){
        delete waypoint['jgTime'];
      } else {
        waypoint.jgDelta = waypoint['jgTime'] - waypoint.elapsedTime;
        waypoint.jgTime = (waypoint.jgTime/ 60) / 24;
        waypoint.jgDelta = waypoint.jgDelta / 60 / 24;
      }

      if(waypoint.mT !== undefined){
        let mtTime = new Date(waypoint.mT);
        waypoint.mtTime = ((mtTime.getTime() - mtStart.getTime())/1000)/ 60;
      }

      if(!waypoint['mtTime']){
        delete waypoint['mtTime'];
      } else {
        waypoint.mtDelta = waypoint['mtTime'] - waypoint.elapsedTime;
        waypoint.mtTime = (waypoint.mtTime/ 60) / 24;
        waypoint.mtDelta = waypoint.mtDelta / 60 / 24;
      }

      if(waypoint.jP !== undefined){
        let jpTime = new Date(waypoint.jP);
        waypoint.jpTime = ((jpTime.getTime() - jpStart.getTime())/1000)/ 60;
      }

      if(!waypoint['jpTime']){
        delete waypoint['jpTime'];
      } else {
        waypoint.jpDelta = waypoint['jpTime'] - waypoint.elapsedTime;
        waypoint.jpTime = (waypoint.jpTime/ 60) / 24;
        waypoint.jpDelta = waypoint.jpDelta / 60 / 24;
      }

      if(waypoint.tW !== undefined){
        let twTime = new Date(waypoint.tW);
        waypoint.twTime = ((twTime.getTime() - twStart.getTime())/1000)/ 60;
      }

      if(!waypoint['twTime']){
        delete waypoint['twTime'];
      } else {
        waypoint.twDelta = waypoint['twTime'] - waypoint.elapsedTime;
        waypoint.twTime = (waypoint.twTime/ 60) / 24;
        waypoint.twDelta = waypoint.twDelta / 60 / 24;
      }

      if(Number.isNaN(waypoint.jgDelta)){
        // delete waypoint['jgDelta'];
      } else {
        waypoint.jgDelta = -1 * Math.round( waypoint.jgDelta * 24 * 10) / 10; // round to a 10th and convert to hours
      }

      if(Number.isNaN(waypoint.mtDelta)){
        // delete waypoint['mtDelta'];
      } else {
        waypoint.mtDelta = -1 * Math.round( waypoint.mtDelta * 24 * 10) / 10; // round to a 10th and convert to hours
      }

      if(Number.isNaN(waypoint.jpDelta)){
        // delete waypoint['jpDelta'];
      } else {
        waypoint.jpDelta = -1 * Math.round( waypoint.jpDelta * 24 * 10) / 10; // round to a 10th and convert to hours
      }

      if(Number.isNaN(waypoint.twDelta)){
        // delete waypoint['twDelta'];
      } else {
        waypoint.twDelta = -1 * Math.round( waypoint.twDelta * 24 * 10) / 10; // round to a 10th and convert to hours
      }

      waypoint.splitTime = (waypoint.splitTime / 60); // convert to hours
      waypoint.splitTime = Math.round( waypoint.splitTime * 10) / 10; // round to a 10th

      waypoint.totalMovingTime = (waypoint.totalMovingTime / 60); // convert to days
      waypoint.totalMovingTime = Math.round( waypoint.totalMovingTime * 10) / 10; // round to a 10th

      waypoint.totalRestTime = (waypoint.totalRestTime / 60); // convert to hours
      waypoint.totalRestTime = Math.round( waypoint.totalRestTime * 100) / 100; // round to a 10th

      waypoint.restTime = (waypoint.restTime / 60); // convert to hours
      waypoint.restTime = Math.round( waypoint.restTime * 100) / 100; // round to a 10th

      waypoint.weight = Math.round( waypoint.weight * 100) / 100; // round to a 10th


      let startDate = new Date(2019,START_MONTH - 1,START_DAY, START_HOUR, START_MIN);
      startDate.setMinutes(startDate.getMinutes() + (waypoint.elapsedTime));

      waypoint.elapsedTime = (waypoint.elapsedTime / 60) / 24; // convert to days

      waypoint.splitElevationGain = Math.round( waypoint.splitElevationGain * METERS_TO_FEET / 100 ) * 100; // round to nearest 100
      waypoint.splitElevationDrop = Math.round( waypoint.splitElevationDrop * METERS_TO_FEET / 100 ) * 100; // round to nearest 100

      waypoint.elapsedTime = Math.round( waypoint.elapsedTime * 10) / 10; // round to a 10th



      waypoint.date = formatDate(startDate);
      waypoint.unixTime = Math.round(startDate.getTime() / 1000)

      waypoint.splitDistance = Math.round( waypoint.splitDistance * 10) / 10; // round to a 10th
      waypoint.splitSpeed = Math.round( waypoint.splitSpeed * 10) / 10; // round to a 100th

      // waypoint.totalDst = ACTUAL_TOTAL_DISTANCE - waypoint.totalDst;
      waypoint.totalDst = Math.round( waypoint.totalDst * 10) / 10; // round to a 10th

      waypoint.jgTime = Math.round( waypoint.jgTime * 10) / 10; // round to a 10th
      waypoint.mtTime = Math.round( waypoint.mtTime * 10) / 10; // round to a 10th

      if(waypoint.splitTime > 0) maxSplitTime = Math.max(maxSplitTime, waypoint.splitTime);

      // delete waypoint['lat'];
      // delete waypoint['lon'];
      // delete waypoint['unixTime'];

      // delete waypoint['totalRestTime'];
      delete waypoint['closestTrackpointIndex'];
      delete waypoint['trackpointError'];
      delete waypoint['eleFt'];
      delete waypoint['tecFactor'];
      delete waypoint['totalElevationGain'];
      delete waypoint['totalElevationDrop'];

      delete waypoint['jG'];
      delete waypoint['mT'];
      delete waypoint['jP'];
      delete waypoint['tW'];

      delete waypoint['jgDelta'];
      delete waypoint['mtDelta'];
      delete waypoint['jpDelta'];
      delete waypoint['twDelta'];
      delete waypoint['weightTime'];

      delete waypoint['jgTime'];
      delete waypoint['mtTime'];


    });

    // waypoints = waypoints.filter(waypoint => waypoint.mtTime);
    // waypoints = waypoints.filter(waypoint => waypoint.jgTime);

    console.log(waypoints[waypoints.length - 1].elapsedTime);



    if( req.query.fmt === "csv" ) {
      const csv = parse(waypoints);
      res.setHeader('Content-disposition', 'attachment; filename=long-trail.csv');
      res.set('Content-Type', 'text/csv');
      res.send(csv);
    } else {
      res.send(waypoints);
    }

    console.log(maxSplitTime);
  }).catch(error => console.error(error));

  // XML JS END

});

function getData(fileName) {
  return new Promise(function(resolve, reject){
    fs.readFile(fileName, (err, data) => {
      err ? reject(err) : resolve(data);
    });
  });
}

function formatDate(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0'+minutes : minutes;
    var strTime = hours + ':' + minutes + ' ' + ampm;
    return date.getMonth()+1 + "/" + date.getDate() + "/" + date.getFullYear() + "  " + strTime;
}

function getHaversineDistance(coords1, coords2, isMiles) {
  function toRad(x) {
    return x * Math.PI / 180;
  }

  var lon1 = coords1[0];
  var lat1 = coords1[1];

  var lon2 = coords2[0];
  var lat2 = coords2[1];

  var R = 6371; // km

  var x1 = lat2 - lat1;
  var dLat = toRad(x1);
  var x2 = lon2 - lon1;
  var dLon = toRad(x2)
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  var d = R * c;

  if(isMiles) d /= 1.60934;

  return d;
}

module.exports = router;
