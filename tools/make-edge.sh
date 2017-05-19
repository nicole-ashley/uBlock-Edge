#!/usr/bin/env bash
#
# This script assumes a linux environment

echo "*** uBlock0.edge: Creating web store package"
echo "*** uBlock0.edge: Copying files"

DES=dist/build/uBlock0.edge
rm -rf $DES
mkdir -p $DES

bash ./tools/make-assets.sh $DES

cp -R src/css               $DES/
cp -R src/img               $DES/
cp -R src/js                $DES/
cp -R src/lib               $DES/
cp -R src/_locales          $DES/
cp -R $DES/_locales/nb      $DES/_locales/no
cp src/*.html               $DES/
cp platform/edge/*.js       $DES/js/
cp -R platform/edge/img     $DES/
cp platform/edge/*.html     $DES/
cp platform/edge/*.json     $DES/
cp LICENSE.txt              $DES/

# Edge doesn't support 'fullwide' as a date format
sed -i "s/'fullwide',\s*//g" $DES/js/*.js

# Edge doesn't support loading local files without extensions
mv $DES/assets/thirdparties/mirror1.malwaredomains.com/files/justdomains $DES/assets/thirdparties/mirror1.malwaredomains.com/files/justdomains.txt
mv $DES/assets/thirdparties/pgl.yoyo.org/as/serverlist $DES/assets/thirdparties/pgl.yoyo.org/as/serverlist.txt
sed -i "s/files\/justdomains/files\/justdomains.txt/g" $DES/assets/checksums.txt
sed -i "s/as\/serverlist/as\/serverlist.txt/g" $DES/assets/checksums.txt
sed -i "s/files\/justdomains\":/files\/justdomains.txt\":/g" $DES/assets/ublock/filter-lists.json
sed -i "s/as\/serverlist\":/as\/serverlist.txt\":/g" $DES/assets/ublock/filter-lists.json

if [ "$1" = all ]; then
    echo "*** uBlock0.edge: Creating package..."
    pushd $(dirname $DES/) > /dev/null
    zip uBlock0.edge.zip -qr $(basename $DES/)/*
    popd > /dev/null
fi

echo "*** uBlock0.edge: Package done."
