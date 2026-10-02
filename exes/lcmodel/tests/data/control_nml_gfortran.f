      program nmldrv
c     NAMELIST output reference for control.rs: bit patterns, then the
c     namelist as gfortran writes it.
      character*6 ch(14), cs(3)*20, one*9
      integer ia(23), ib
      real ra(60), rb, r2(3,4)
      double precision da(40), db
      logical la(13), lb
      integer ira(60), irb, ir2(12), ida(80), idb(2)
      equivalence (ra, ira), (rb, irb), (r2, ir2), (da, ida), (db, idb)
      namelist /TestGrp/ ch, cs, one, ia, ib, ra, rb, r2, da, db, la, lb
      do 10 j = 1, 14
         ch(j) = 'Cr'
         if (j .gt. 3) ch(j) = ' '
         if (j .eq. 9) ch(j) = 'NAA+x'
 10   continue
      cs(1) = 'a"b''c'
      cs(2) = ' '
      cs(3) = ' lead'
      one = 'x'
      do 20 j = 1, 23
         ia(j) = (j - 11) ** 3 * 1000
         if (j .gt. 15   .and.   j .lt. 20) ia(j) = 7
 20   continue
      ib = -2147483647
      do 30 j = 1, 60
         ra(j) = sin(float(j)) * 10.**(mod(j, 23) - 11)
         if (j .gt. 50) ra(j) = 1.5
 30   continue
      ra(3) = 0.
      ra(4) = -ra(3)
      ra(5) = 0.1
      ra(6) = 999999999.
      ra(7) = 99999999.
      ra(8) = 0.09999999
      ra(9) = 1.e-40
      ra(10) = 9.e37
      ra(11) = 5.e-4
      ra(12) = 127.786142
      rb = 1234567.
      do 40 j = 1, 12
         r2(mod(j - 1, 3) + 1, (j - 1) / 3 + 1) = float(j) / 7.
 40   continue
      r2(1, 1) = r2(2, 1)
      do 50 j = 1, 40
         da(j) = dsin(dble(j)) * 10.d0**(mod(j, 29) - 14)
 50   continue
      da(2) = 0.d0
      da(3) = -da(2)
      da(4) = da(5)
      da(6) = 1.d300
      da(7) = 2.1d-7
      db = 1.d0 / 3.d0
      do 60 j = 1, 13
         la(j) = mod(j, 4) .eq. 0
 60   continue
      lb = .true.
      open (9, file='control_nml_gfortran.txt')
      write (9, 5010) ira, irb, ir2, ida, idb
 5010 format (6i12)
      write (9, 5020)
 5020 format ('NAMELIST')
      write (9, nml=TestGrp)
      end
